import assert from 'node:assert/strict'
import test from 'node:test'
import { formatMetrics, secs, taskMetrics } from '../src/engine/metrics.ts'
import type { Task } from '../src/engine/types.ts'
import { isCheck } from '../src/engine/types.ts'
import { Clock, PASS } from './helpers.ts'

const stage = (t: Task, node: string, now = 1e9) => taskMetrics(t, now).stages.find(s => s.node === node)!

test('a stage splits its wall time into agent, check, user wait, blocked and platform overhead', () => {
  const c = new Clock('review')
  c.reply(1000, 800, '方案') // plan：[200, 1000]
  // build：调用从 1100 开始，1300 时 agent 提问，用户 1700 回答，调用 2100 结束（耗时 1000，其中等用户 400）
  const build = c.call
  c.send(1300, { kind: 'asked', call: build, question: { id: 'q1', text: '用整数吗？' } })
  c.send(1700, { kind: 'answered', questionId: 'q1', text: '是' })
  c.reply(2100, 1000, '实现完了')
  c.check(2400, 200) // 交付物检查：[2200, 2400]
  const m = stage(c.task, 'build')
  assert.deepEqual(
    { calls: m.calls, checks: m.checks, agent: m.agentMs, check: m.checkMs, wait: m.waitUserMs, blocked: m.blockedMs, overhead: m.overheadMs, wall: m.wallMs },
    { calls: 1, checks: 1, agent: 600, check: 200, wait: 400, blocked: 0, overhead: 100, wall: 1300 },
  )
  assert.equal(m.usage.input, 100)
  assert.equal(stage(c.task, 'plan').agentMs, 800)
  assert.equal(stage(c.task, 'plan').wallMs, 800)
})

test('a failed call blocks its stage until a person retries, and an open stage runs to now', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案')
  c.send(1500, { kind: 'call_failed', call: c.call, error: 'dsh 进程退出' })
  // 还没重试：阻塞算到 now，阶段进行中
  const open = stage(c.task, 'build', 4000)
  assert.equal(open.open, true)
  assert.equal(open.blockedMs, 2500)
  assert.equal(open.end, 4000)
  c.send(5000, { kind: 'retry' })
  c.reply(5600, 500, '实现完了')
  const m = stage(c.task, 'build', 9000)
  assert.equal(m.blockedMs, 3500, 'from the failure note to the retry note')
  assert.equal(m.agentMs, 500)
  assert.equal(m.calls, 1, 'a failed call writes no call entry')
  assert.equal(m.open, false, 'the task moved on to review')
  assert.equal(m.wallMs, 4100)
  assert.equal(m.overheadMs, 100)
  assert.equal(stage(c.task, 'review', 9000).open, true)
})

test('an unparseable reply that pauses the task also counts as blocked', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案')
  c.reply(2000, 500, '实现完了')
  // 评审回复两次都无法解析，任务暂停
  for (let at = 3000; c.task.status !== 'failed'; at += 1000) c.reply(at, 500, '我觉得还行')
  const failedAt = c.task.log.at(-1)!.at
  const m = stage(c.task, 'review', failedAt + 2000)
  assert.equal(m.blockedMs, 2000)
})

test('a loop question waits for the user in its stage; a finished task stops the clock at its last entry', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案')
  c.reply(2000, 500, '实现完了')
  c.reply(3000, 500, '```json\n{"verdict":"changes","summary":"缺测试","issues":[{"severity":"major","message":"补测试"}]}\n```')
  c.reply(4000, 500, '补了')
  c.reply(5000, 500, '```json\n{"verdict":"changes","summary":"还缺","issues":[{"severity":"major","message":"补测试"}]}\n```')
  assert.equal(c.task.status, 'waiting_user')
  const q = c.task.question!
  assert.equal(q.source, 'loop')
  c.send(8000, { kind: 'answered', questionId: q.id, text: '再来一轮' })
  for (let at = 9000; (c.task.status as string) !== 'done'; at += 1000) c.reply(at, 500, c.task.pending!.purpose === 'critique' ? PASS : '好了')
  const m = taskMetrics(c.task, 1e12)
  const review = m.stages.find(s => s.node === 'review')!
  assert.equal(review.waitUserMs, 3000)
  assert.ok(m.stages.every(s => !s.open))
  assert.ok(m.total.wallMs < 1e6, 'a done task is not measured up to now')
})

test('stages follow workflow order and skip stages that never ran', () => {
  const c = new Clock('review')
  c.reply(1000, 1000, '方案')
  const m = taskMetrics(c.task, 3000)
  assert.deepEqual(m.stages.map(s => [s.node, s.open]), [['plan', false], ['build', true]])
  assert.equal(m.stages[1]!.wallMs, 2000, 'an open stage runs from the end of the previous one')
  assert.deepEqual([m.stages[1]!.runningMs, m.stages[1]!.overheadMs], [2000, 0], 'its call is running, not platform overhead')
  assert.equal(m.total.calls, 1)
})

/** 各部分不重复计算：加起来不超过阶段时长，平台开销补齐到正好相等；阶段之间不重叠。 */
const consistent = (t: Task, now: number) => {
  const m = taskMetrics(t, now, 0)
  for (const s of m.stages) {
    assert.ok(s.agentMs >= 0 && s.checkMs >= 0 && s.waitUserMs >= 0 && s.blockedMs >= 0, JSON.stringify(s))
    assert.ok(s.agentMs + s.runningMs + s.checkMs + s.waitUserMs + s.blockedMs <= s.wallMs, JSON.stringify(s))
    assert.equal(s.agentMs + s.runningMs + s.checkMs + s.waitUserMs + s.blockedMs + s.overheadMs, s.wallMs)
  }
  for (let i = 1; i < m.stages.length; i++) assert.ok(m.stages[i]!.start === undefined || m.stages[i]!.start! >= m.stages[i - 1]!.end!, 'stages do not overlap')
  assert.equal(m.total.wallMs + m.betweenMs, m.elapsedMs)
  return m
}

test('a question that is never answered stops waiting when the call fails, and is not counted twice with the blocked time', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案')
  c.send(1500, { kind: 'asked', call: c.call, question: { id: 'q', text: '?' } })
  c.send(2000, { kind: 'call_failed', call: c.call, error: '断了' })
  c.send(3000, { kind: 'retry' })
  c.reply(4000, 500, '实现完了')
  for (let at = 5000; (c.task.status as string) !== 'done'; at += 1000) c.reply(at, 500, PASS)
  const build = consistent(c.task, 1e9).stages.find(s => s.node === 'build')!
  assert.deepEqual([build.waitUserMs, build.blockedMs, build.end], [500, 1000, 4000])
})

test('a question replaced by another (the agent asks again after a restart) ends at the new one; overlapping waits are not subtracted twice', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案')
  const call = c.call
  c.send(1500, { kind: 'asked', call, question: { id: 'a', text: '?' } })
  c.send(1600, { kind: 'asked', call, question: { id: 'b', text: '换个问法？' } })
  c.send(2400, { kind: 'answered', questionId: c.task.question!.id, text: '好' })
  c.reply(2500, 1400, '实现完了')
  const build = consistent(c.task, 100_000).stages.find(s => s.node === 'build')!
  assert.deepEqual([build.agentMs, build.waitUserMs, build.wallMs, build.end], [500, 900, 1400, 2500])
})

test('a question still waiting runs to now; an abort while waiting stops it', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案')
  c.send(1500, { kind: 'asked', call: c.call, question: { id: 'q', text: '?' } })
  assert.equal(consistent(c.task, 6000).stages.find(s => s.node === 'build')!.waitUserMs, 4500)
  c.send(7000, { kind: 'abort' })
  const build = consistent(c.task, 1e9).stages.find(s => s.node === 'build')!
  assert.deepEqual([build.waitUserMs, build.end], [5500, 7000])
})

test('every metric stays consistent through dialog rounds, check failures and fixes', () => {
  const c = new Clock('review')
  let at = 0
  const step = () => (at += 1000)
  c.reply(step(), 600, '方案')
  c.reply(step(), 600, '实现')
  c.check(step(), 300, false) // 交付物不全：补齐
  consistent(c.task, at)
  while ((c.task.status as string) !== 'done') {
    const p = c.task.pending!
    if (isCheck(p)) c.check(step(), 300, true)
    else c.reply(step(), 600, p.purpose === 'critique' ? PASS : '好了')
    consistent(c.task, at)
  }
  const m = consistent(c.task, 1e9)
  assert.ok(m.stages.find(s => s.node === 'build')!.checks >= 2)
})

test('time between stages is not in any stage and is reported separately', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案') // plan [0, 1000]
  c.reply(9000, 500, '实现完了') // build [8500, 9000]：中间 7.5s 平台停着
  const m = taskMetrics(c.task, 9000)
  assert.equal(m.elapsedMs, 9000)
  assert.equal(m.total.wallMs, 1500, 'review has just opened at 9000')
  assert.equal(m.betweenMs, 7500)
})

test('the command-line table has a row per stage and a total, and marks the open stage', () => {
  const c = new Clock()
  c.reply(1000, 1000, '方案', 12_345)
  const text = formatMetrics(taskMetrics(c.task, 2500))
  const lines = text.split('\n')
  assert.equal(lines.length, 5)
  assert.match(lines[4]!, /^任务总时长 2\.5s，其中不在任何阶段的 0ms/)
  assert.match(lines[0]!, /^阶段\s+调用/)
  assert.match(lines[1]!, /^plan\s+1\s+0\s+12\.3k/)
  assert.match(lines[2]!, /^build（进行中）/)
  assert.match(lines[3]!, /^合计\s+1/)
})

test('durations round as a whole, never showing 60 seconds', () => {
  assert.deepEqual([999, 1000, 59_949, 59_950, 119_600, 3_599_600].map(secs), ['999ms', '1.0s', '59.9s', '1m0s', '2m0s', '60m0s'])
})

test('a running call shows as in progress, from the last entry to now; the first stage starts when the task was created', () => {
  const c = new Clock()
  // 任务 0 创建，plan 的调用正在跑，还没有任何记录
  const first = taskMetrics(c.task, 5000, 0).stages[0]!
  assert.deepEqual([first.open, first.wallMs, first.runningMs, first.overheadMs], [true, 5000, 5000, 0])
  assert.equal(taskMetrics(c.task, 5000).stages[0]!.wallMs, 0, 'without the creation time the first stage has no start')
  c.send(6000, { kind: 'asked', call: c.call, question: { id: 'q', text: '?' } })
  const waiting = taskMetrics(c.task, 8000, 0).stages[0]!
  assert.deepEqual([waiting.runningMs, waiting.waitUserMs, waiting.overheadMs], [6000, 2000, 0], 'the call ran 6s before asking; the wait is not running')
  c.send(9000, { kind: 'answered', questionId: c.task.question!.id, text: '好' })
  const again = taskMetrics(c.task, 12_000, 0).stages[0]!
  assert.deepEqual([again.runningMs, again.waitUserMs, again.wallMs], [9000, 3000, 12_000])
  c.reply(13_000, 13_000, '方案')
  const doneStage = taskMetrics(c.task, 13_000, 0).stages[0]!
  assert.deepEqual([doneStage.agentMs, doneStage.runningMs, doneStage.waitUserMs], [10_000, 0, 3000], 'once the call ends it is agent time')
  consistent(c.task, 20_000)
})

test('running time in every engine state: a check, a failure, a retry, a loop question and its answer', () => {
  const c = new Clock('review')
  c.reply(1000, 1000, '方案')
  c.reply(3000, 1000, '实现') // build 的交付物检查正在跑
  const run = (now: number) => taskMetrics(c.task, now, 0).stages.find(s => s.open)!
  assert.deepEqual([run(3500).node, run(3500).runningMs], ['build', 500], 'a check in flight runs from the reply before it')
  c.check(4000, 400, false) // 交付物不全：补齐调用
  assert.equal(run(5000).runningMs, 1000, 'the fix call runs from the check result')
  c.send(5500, { kind: 'call_failed', call: c.call, error: '断了' })
  assert.deepEqual([run(7000).runningMs, run(7000).blockedMs], [0, 1500], 'a failed task runs nothing; it is blocked')
  c.send(8000, { kind: 'retry' })
  assert.equal(run(8600).runningMs, 600, 'the resent call runs from the retry')
  c.reply(9000, 900, '补齐了')
  c.check(9500, 300, false) // 又不全，补齐次数用完：对话尽头的提问
  assert.equal(c.task.status, 'waiting_user')
  assert.equal(c.task.question!.source, 'loop')
  assert.deepEqual([run(11_000).runningMs, run(11_000).waitUserMs], [0, 1500], 'waiting at the end of the loop runs nothing')
  c.send(12_000, { kind: 'answered', questionId: c.task.question!.id, text: '继续补' })
  assert.ok(c.task.pending !== undefined)
  assert.equal(run(12_700).runningMs, 700, 'after the answer the next call runs from the answer')
  consistent(c.task, 12_700)
})
