import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Task } from '../src/engine/types.ts'
import { upgradeTask } from '../src/store/store.ts'
import { bounds, buildTrace } from '../src/trace/build.ts'
import type { Span, TraceEvent } from '../src/trace/types.ts'

/** 真实任务：LRU 缓存，规划问了两个问题，评审第一轮通过。trace 是从 dsh 会话日志回放的。 */
// 这份记录来自第 1 块之前的真实任务：和存储一样，读出时补上新字段的默认值。
const raw = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'lru-task.json'), 'utf8')) as { task: Task; trace: { call: string; event: TraceEvent }[] }
const fixture = { ...raw, task: upgradeTask(raw.task) }

const all = (s: Span): Span[] => [s, ...s.children.flatMap(all)]
const count = (call: string, kind: TraceEvent['kind']) => fixture.trace.filter(r => r.call === call && r.event.kind === kind).length

test('the tree is task → nodes → calls, each call under the node it advanced', () => {
  const root = buildTrace(fixture.task, fixture.trace)
  assert.equal(root.kind, 'task')
  assert.equal(root.status, 'ok')
  assert.deepEqual(root.children.map(n => [n.name, n.status]), [['plan', 'ok'], ['build', 'ok'], ['review', 'ok']])
  assert.deepEqual(root.children.map(n => n.children.filter(c => c.kind === 'call').map(c => c.id)), [['c1'], ['c2'], ['c3']])
  assert.equal(root.children[2]!.children.find(c => c.kind === 'call')!.name, 'reviewer · 评审 · 第 1 轮')
})

test('every model request and every tool call in the log appears exactly once, tools under the step that asked for them', () => {
  const root = buildTrace(fixture.task, fixture.trace)
  for (const call of ['c1', 'c2', 'c3']) {
    const span = all(root).find(s => s.id === call)!
    const steps = span.children.filter(c => c.kind === 'model')
    assert.equal(steps.length, count(call, 'step_start'), `${call} steps`)
    const tools = steps.flatMap(s => s.children.filter(c => c.kind === 'tool'))
    assert.equal(tools.length, count(call, 'tool_start'), `${call} tools`)
    assert.equal(new Set(tools.map(t => t.id)).size, tools.length)
    assert.ok(tools.every(t => t.end !== undefined && t.output !== undefined), `${call}: every tool has a result`)
  }
})

test('token usage replayed from the log adds up to what the live run recorded for each call', () => {
  const root = buildTrace(fixture.task, fixture.trace)
  for (const entry of fixture.task.log) {
    if (entry.type !== 'call') continue
    const steps = all(root).find(s => s.id === entry.call)!.children.filter(c => c.kind === 'model')
    const sum = steps.reduce((u, s) => ({ input: u.input + s.usage!.input, output: u.output + s.usage!.output, cacheRead: u.cacheRead + s.usage!.cacheRead }), { input: 0, output: 0, cacheRead: 0 })
    assert.deepEqual(sum, { input: entry.usage.input, output: entry.usage.output, cacheRead: entry.usage.cacheRead }, entry.call)
  }
})

test('the first step’s input is the prompt, later steps’ input is the previous step’s tool results', () => {
  const c1 = all(buildTrace(fixture.task, fixture.trace)).find(s => s.id === 'c1')!
  const steps = c1.children.filter(c => c.kind === 'model')
  assert.equal(steps[0]!.input, c1.input)
  const firstTools = steps[0]!.children.filter(c => c.kind === 'tool')
  if (firstTools.length > 0) assert.ok(steps[1]!.input!.includes(firstTools[0]!.output!.slice(0, 40)))
})

test('the planner’s questions and the answers sit inside its call, in time order', () => {
  const c1 = all(buildTrace(fixture.task, fixture.trace)).find(s => s.id === 'c1')!
  const qa = c1.children.filter(c => c.kind === 'question' || c.kind === 'answer').map(c => c.name)
  assert.deepEqual(qa, ['提问 q1', '回答 q1', '提问 q2', '回答 q2'])
  assert.ok(c1.children.every((c, i, a) => i === 0 || a[i - 1]!.start <= c.start), 'children sorted by start')
})

test('spans never end before they start and the waterfall bounds cover the whole task', () => {
  const root = buildTrace(fixture.task, fixture.trace)
  for (const s of all(root)) if (s.end !== undefined) assert.ok(s.end >= s.start, `${s.id} ${s.name}`)
  const b = bounds(root, Date.now())
  assert.ok(all(root).every(s => s.start === 0 || (s.start >= b.start && (s.end ?? s.start) <= b.end)))
})

test('a call still in flight shows as running, with its open step and tool unfinished', () => {
  const c3 = fixture.trace.filter(r => r.call === 'c3')
  const cut = c3.findIndex(r => r.event.kind === 'tool_start')
  const partial = [...fixture.trace.filter(r => r.call !== 'c3'), ...c3.slice(0, cut + 1)]
  const log = fixture.task.log.filter(e => !(e.type === 'call' && e.call === 'c3') && !(e.type === 'note' && e.at >= fixture.task.log.find(x => x.type === 'call' && x.call === 'c3')!.at))
  const running: Task = { ...fixture.task, status: 'running', cursor: 2, log,
    pending: { id: 'c3' as never, node: 'review' as never, session: 'review' as never, role: 'reviewer' as never, purpose: 'critique', prompt: '评审' },
    dialog: { node: 'review' as never, round: 1, escalated: false, phase: 'critique', formatRetries: 0, review: 'first' } }
  const root = buildTrace(running, partial)
  const review = root.children[2]!
  assert.equal(review.status, 'running')
  const call = review.children.find(c => c.id === 'c3')!
  assert.equal(call.status, 'running')
  assert.equal(call.end, undefined)
  const step = call.children.filter(c => c.kind === 'model').at(-1)!
  assert.equal(step.end, undefined)
  assert.equal(step.children.at(-1)!.status, 'running')
  assert.equal(root.end, undefined)
})

test('a call that was running when the task was aborted stays in its node, marked aborted, with its usage', () => {
  const c3 = fixture.trace.filter(r => r.call === 'c3').map(r => (r.event.kind === 'call_start'
    ? { ...r, event: { ...r.event, call: { node: 'review', role: 'reviewer', purpose: 'critique' as const, prompt: '评审' } } } : r))
  const log = fixture.task.log.filter(e => !(e.type === 'call' && e.call === 'c3') && !(e.type === 'note' && e.node === 'review'))
  const aborted: Task = { ...fixture.task, status: 'aborted', cursor: 2, log, pending: undefined }
  const root = buildTrace(aborted, [...fixture.trace.filter(r => r.call !== 'c3'), ...c3])
  const call = root.children[2]!.children.find(c => c.id === 'c3')!
  assert.equal(call.status, 'error')
  assert.match(call.name, /已中止/)
  assert.ok(call.usage!.input > 0, 'its tokens still count')
  assert.ok(root.usage!.input >= call.usage!.input)
})

test('platform checks show under their node as check spans, one child per check with the reason it failed', async () => {
  const { Driver, workflow } = await import('./helpers.ts')
  const d = new Driver(workflow({ maxRounds: 2, escalate: true, checks: 'review' }))
  d.reply('方案')
  d.reply('实现')
  d.check(false, '缺少章节：改动')
  d.reply('补齐了')
  d.check(true)
  const running = buildTrace(d.task, [])
  const build = running.children[1]!
  const checks = build.children.filter(c => c.kind === 'check')
  assert.deepEqual(checks.map(c => [c.status, c.meta['结果']]), [['error', '0/1 项通过'], ['ok', '1/1 项通过']])
  assert.equal(checks[0]!.children[0]!.output, '缺少章节：改动')
  assert.match(checks[0]!.children[0]!.name, /NOTES\.md 存在并包含章节：改动/)
  // 测试驱动的时间戳是假的（每步 +1ms，调用耗时 5ms），按开始时间排不出真实顺序；按调用编号看：产出、检查、补齐、检查。
  const byId = build.children.filter(c => c.kind !== 'note').sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
  assert.deepEqual(byId.map(c => c.kind === 'call' ? c.name.split(' · ')[1] : c.kind), ['完成工作', 'check', '补齐交付物', 'check'])
  assert.match(build.meta['验收检查']!, /NOTES\.md/)
  const review = running.children[2]!
  assert.deepEqual(review.children.map(c => [c.kind, c.status]), [['check', 'running']], 'the review round’s tests are running')
})

test('被撤销的越界改动显示在调用 span 的 meta 上，节点下也有一条说明', async () => {
  const { Driver, workflow } = await import('./helpers.ts')
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }))
  d.reply('方案')
  const call = d.pending
  d.send({ kind: 'replied', call: call.id, sessionId: 's-build', text: '实现', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1, reverted: ['README.md', 'secrets.txt'] })
  const build = buildTrace(d.task, []).children[1]!
  const span = build.children.find(c => c.kind === 'call')!
  assert.equal(span.meta['撤销的越界改动'], 'README.md、secrets.txt')
  assert.deepEqual(build.children.filter(c => c.kind === 'note').map(c => c.name), ['撤销了 2 处越界改动：README.md、secrets.txt'])
  const clean = buildTrace(new Driver(workflow({ maxRounds: 2, escalate: true })).task, []).children[0]!
  assert.equal(clean.children.some(c => '撤销的越界改动' in c.meta), false, '没有越界就不显示这一项')
})
