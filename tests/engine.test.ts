import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_FORMAT_RETRIES, reduce } from '../src/engine/machine.ts'
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
