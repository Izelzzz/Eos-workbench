import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_FORMAT_RETRIES, reduce } from '../src/engine/machine.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import { ASK, CHANGES, Driver, GARBAGE, PASS, REVISE, workflow } from './helpers.ts'

const toReview = (d: Driver) => {
  d.reply('方案 v1')
  d.reply('实现 v1')
}

test('plan → build → review passes on the first round', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  toReview(d)
  assert.equal(d.pending.purpose, 'critique')
  assert.equal(d.pending.session, 'review')
  assert.match(d.pending.prompt, /待评审：build 的说明[\s\S]*实现 v1/)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
  assert.equal(d.task.pending, undefined)
  assert.deepEqual(d.purposes(), ['produce@plan', 'produce@build', 'critique@review'])
})

test('changes go back into the developer’s own session, then the reviewer re-checks', () => {
  const d = new Driver(workflow({ maxRounds: 3, escalate: true }))
  toReview(d)
  d.reply(CHANGES)
  assert.equal(d.pending.purpose, 'respond')
  assert.equal(d.pending.session, 'build', 'developer keeps its session')
  assert.equal(d.pending.role, 'dev')
  assert.match(d.pending.prompt, /评审意见（第 1 轮）[\s\S]*补测试/)
  assert.doesNotMatch(d.pending.prompt, /你的角色/, 'role intro is not repeated in an existing session')
  d.reply('已补测试')
  assert.equal(d.task.dialog?.round, 2)
  assert.equal(d.pending.purpose, 'critique')
  assert.match(d.pending.prompt, /第 2 轮：build 的回复[\s\S]*已补测试/)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
  assert.equal(d.task.outputs.build, '已补测试')
})

test('after maxRounds the upstream re-confirms once, the revised plan resets the rounds', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  toReview(d)
  d.reply(CHANGES)
  d.reply('改了')
  d.reply(CHANGES) // 第 2 轮仍未通过
  assert.equal(d.pending.purpose, 'reconfirm')
  assert.equal(d.pending.session, 'plan', 'planner answers in its own session')
  assert.match(d.pending.prompt, /对话 2 轮仍未通过/)
  d.reply(REVISE)
  assert.equal(d.task.outputs.plan, '新方案：先写测试')
  assert.equal(d.pending.purpose, 'reapply')
  assert.equal(d.pending.session, 'build')
  d.reply('按新方案改了')
  assert.equal(d.task.dialog?.round, 1)
  assert.match(d.pending.prompt, /方案已重新确认[\s\S]*新方案：先写测试/)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
})

test('failing again after the re-confirmation asks the user; the answer goes to the upstream', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: true }))
  toReview(d)
  d.reply(CHANGES)
  d.reply(REVISE)
  d.reply('按新方案改了')
  d.reply(CHANGES)
  assert.equal(d.task.status, 'waiting_user')
  assert.equal(d.task.pending, undefined)
  assert.equal(d.task.question?.source, 'loop')
  assert.match(d.task.question!.text, /已重新确认过一次/)
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '只支持整数' })
  assert.equal(d.pending.purpose, 'reconfirm')
  assert.match(d.pending.prompt, /用户的指示[\s\S]*只支持整数/)
})

test('the upstream can hand the decision to the user instead of revising', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: true }))
  toReview(d)
  d.reply(CHANGES)
  d.reply(ASK)
  assert.equal(d.task.status, 'waiting_user')
  assert.equal(d.task.question?.text, '要不要支持负数？')
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '要' })
  assert.equal(d.pending.purpose, 'reconfirm')
})

test('without an upstream, exhausting the rounds asks the user and the answer goes to the developer', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false }))
  toReview(d)
  d.reply(CHANGES)
  assert.equal(d.task.question?.source, 'loop')
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '先别管测试' })
  assert.equal(d.pending.purpose, 'instruct')
  assert.equal(d.pending.session, 'build')
  d.reply('好的')
  assert.equal(d.task.dialog?.round, 1)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
})

test('an agent can ask mid-call; the call stays pending and continues after the answer', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: true }))
  const call = d.pending
  d.send({ kind: 'asked', call: call.id, question: { id: 'native-1', text: '红色还是绿色？', options: ['红色', '绿色'] } })
  assert.equal(d.task.status, 'waiting_user')
  assert.equal(d.task.question?.source, 'agent')
  assert.equal(d.task.pending, call, 'the call is still in flight')
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '绿色' })
  assert.equal(d.task.status, 'running')
  assert.equal(d.task.pending, call)
  d.reply('方案：绿色')
  assert.equal(d.task.outputs.plan, '方案：绿色')
})

test('an unparseable verdict is asked again, then the task fails with a ready call to retry', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  toReview(d)
  for (let i = 0; i < MAX_FORMAT_RETRIES; i++) {
    d.reply(GARBAGE)
    assert.equal(d.task.status, 'running')
    assert.match(d.pending.prompt, /无法解析/)
  }
  d.reply(GARBAGE)
  assert.equal(d.task.status, 'failed')
  const ready = d.pending
  d.send({ kind: 'retry' })
  assert.equal(d.task.status, 'running')
  assert.equal(d.task.pending, ready)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
})

test('a failed call is retried as the same call', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: true }))
  const call = d.pending
  d.send({ kind: 'call_failed', call: call.id, error: '网络错误' })
  assert.equal(d.task.status, 'failed')
  assert.equal(d.task.failure, '网络错误')
  d.send({ kind: 'retry' })
  assert.equal(d.task.pending?.id, call.id)
})

test('stale replies, empty answers and events after the end are rejected without changes', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: true }))
  const before = d.task
  const stale = reduce(before, { kind: 'replied', call: 'c99' as never, sessionId: 's', text: 'x', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 0 }, 1)
  assert.equal(stale.accepted, false)
  assert.equal(stale.task, before)
  d.send({ kind: 'asked', call: d.pending.id, question: { id: 'n', text: '?' } })
  const empty = reduce(d.task, { kind: 'answered', questionId: d.task.question!.id, text: '  ' }, 2)
  assert.equal(empty.accepted, false)
  d.send({ kind: 'abort' })
  assert.equal(reduce(d.task, { kind: 'retry' }, 3).accepted, false)
})

test('a blocker reported with verdict pass counts as changes', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  toReview(d)
  d.reply('```json\n{"verdict":"pass","issues":[{"severity":"blocker","message":"会崩溃"}]}\n```')
  assert.equal(d.pending.purpose, 'respond')
})

/** 回复当前调用，并带上这次被平台撤销的越界路径。 */
const replyReverting = (d: Driver, text: string, reverted: string[]) => {
  const call = d.pending
  return d.send({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1, reverted })
}

test('被撤销的越界改动记进调用日志和节点说明，并通知同一会话的下一次调用', () => {
  const d = new Driver(workflow({ maxRounds: 3, escalate: true, checks: 'review' }))
  d.reply('方案 v1')
  replyReverting(d, '实现 v1', ['docs/design.md', 'top.txt'])
  const entry = d.task.log.findLast(e => e.type === 'call')
  assert.deepEqual(entry?.type === 'call' ? entry.reverted : undefined, ['docs/design.md', 'top.txt'], '调用日志记下被撤销的路径')
  const note = d.task.log.findLast(e => e.type === 'note')
  assert.deepEqual(note?.type === 'note' ? [note.node, note.text] : undefined, ['build', '撤销了 2 处越界改动：docs/design.md、top.txt'])
  assert.deepEqual(d.task.scopeNotices, { build: ['docs/design.md', 'top.txt'] }, '通知挂在开发的会话上，等下一次调用')

  // 先是开发节点的交付物检查，再是对话这一轮的检查，通过了才请评审（评审在 review 会话，不带这段说明）。
  d.check(true)
  d.check(true)
  assert.equal(d.pending.session, 'review')
  assert.doesNotMatch(d.pending.prompt, /有改动被撤销/, '别的会话不会收到这段说明')
  d.reply(CHANGES)
  // 回应评审走 build 会话：这时才带上说明。
  assert.equal(d.pending.session, 'build')
  assert.match(d.pending.prompt, /# 有改动被撤销（超出你的可写范围）[\s\S]*- docs\/design\.md\n- top\.txt/)
  assert.match(d.pending.prompt, /你可以改动任务 worktree 里的任何文件。/, '同时说明允许的范围')
  assert.match(d.pending.prompt, /有改动被撤销[\s\S]*评审意见（第 1 轮）/, '说明加在原来的提示词最前面')
  assert.deepEqual(d.task.scopeNotices, {}, '发出去之后就清除')
  // 第 2 轮：再一次回到 build 会话时不会重复通知。
  d.reply('已改')
  d.check(true)
  d.reply(CHANGES)
  assert.equal(d.pending.session, 'build')
  assert.doesNotMatch(d.pending.prompt, /有改动被撤销/, '不会重复通知')
})

test('同一个会话再次越界：通知换成最新一次的路径，每次只通知一遍', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true, checks: 'only', maxFixes: 2 }))
  d.reply('方案 v1')
  replyReverting(d, '实现 v1', ['top.txt'])
  d.check(false)
  assert.equal(d.pending.purpose, 'fix')
  assert.match(d.pending.prompt, /有改动被撤销[\s\S]*- top\.txt/)
  assert.deepEqual(d.task.scopeNotices, {}, '发给补齐调用之后就清除')
  replyReverting(d, '已补齐', ['out/a.txt'])
  assert.deepEqual(d.task.scopeNotices, { build: ['out/a.txt'] })
  d.check(false)
  assert.match(d.pending.prompt, /有改动被撤销[\s\S]*- out\/a\.txt/)
  assert.doesNotMatch(d.pending.prompt, /- top\.txt/, '上一次已经通知过的不再重复')
  assert.deepEqual(d.task.scopeNotices, {})
})

test('没有越界改动时提示词和日志都不变', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  d.reply('方案 v1')
  replyReverting(d, '实现 v1', [])
  const entry = d.task.log.findLast(e => e.type === 'call')
  assert.equal(entry?.type === 'call' ? 'reverted' in entry : true, false, '空数组不写进日志')
  assert.deepEqual(d.task.scopeNotices, {})
  assert.doesNotMatch(d.pending.prompt, /有改动被撤销/)
})

test('会话第一条消息就告诉 agent 可写范围，范围外的位置改放到范围内、不问用户；之后同一会话不重复', () => {
  const r = parseWorkflow(`
name: t
roles:
  planner: { prompt: 你负责规划 }
  dev: { prompt: 你负责开发, write: worktree, writePaths: [src/**, tests/**] }
nodes:
  - { id: plan, kind: agent, role: planner, task: 写方案 }
  - { id: build, kind: agent, role: dev, task: 实现, inputs: [plan] }
  - { id: review, kind: dialog, role: planner, with: build, maxRounds: 2, task: 评审 }
`)
  assert.ok(r.ok)
  const d = new Driver(r.workflow)
  assert.match(d.pending.prompt, /# 你的可写范围\n\n你这个角色是只读的，不能改动任何文件/, '只读角色')
  d.reply('方案 v1')
  assert.match(d.pending.prompt, /# 你的角色[\s\S]*# 你的可写范围\n\n你可以改动的路径（任务 worktree 内的 glob）：\n- src\/\*\*\n- tests\/\*\*/)
  assert.match(d.pending.prompt, /改放到范围内最合适的位置，并在回复里写明放在了哪里、为什么；不要为路径向用户提问/)
  assert.doesNotMatch(d.pending.prompt, /由用户决定/)
  d.reply('实现 v1')
  d.reply(CHANGES)
  assert.equal(d.pending.session, 'build')
  assert.doesNotMatch(d.pending.prompt, /你的可写范围/, '同一会话里不重复')
})

test('整个 worktree 可写时不列 glob；越界撤销后的说明用同一条规则', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  d.reply('方案 v1')
  assert.match(d.pending.prompt, /# 你的可写范围\n\n你可以改动任务 worktree 里的任何文件。/)
  replyReverting(d, '实现 v1', ['top.txt'])
  d.reply(CHANGES)
  assert.match(d.pending.prompt, /# 有改动被撤销[\s\S]*- top\.txt[\s\S]*你可以改动任务 worktree 里的任何文件。[\s\S]*不要为路径向用户提问/)
  assert.doesNotMatch(d.pending.prompt, /由用户决定/)
})
