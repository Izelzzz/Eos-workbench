// 交付物检查与对话检查：agent 节点不通过就让同一个 agent 补齐，对话每一轮先跑检查再评审。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reduce } from '../src/engine/machine.ts'
import { CHANGES, Driver, PASS, workflow } from './helpers.ts'

const toBuildChecks = (d: Driver) => {
  d.reply('方案 v1')
  assert.match(d.pending.prompt, /交付要求[\s\S]*NOTES\.md 存在并包含章节：改动/, 'the developer is told the deliverable up front')
  d.reply('实现 v1')
}

test('a failing deliverable goes back to the same agent with the reasons, then passes and moves on', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true, checks: 'review' }))
  toBuildChecks(d)
  assert.equal(d.checking.node, 'build')
  d.check(false, '缺少章节：改动')
  assert.equal(d.pending.purpose, 'fix')
  assert.equal(d.pending.session, 'build', 'the fix goes into the developer’s own session')
  assert.match(d.pending.prompt, /交付物检查没有通过[\s\S]*NOTES\.md[\s\S]*缺少章节：改动/)
  assert.equal(d.task.fixes, 1)
  d.reply('补上了改动一节')
  d.check(true)
  assert.equal(d.task.fixes, 0, 'fixes reset when the next node starts')
  assert.equal(d.checking.node, 'review', 'the review dialog runs its tests first')
  assert.match(d.task.outputs.build!, /实现 v1[\s\S]*补齐说明[\s\S]*补上了改动一节/)
  assert.ok(d.task.log.some(e => e.type === 'note' && e.node === 'build' && e.text === '交付物检查通过'))
})

test('after maxFixes the user is asked; the answer goes to the same agent with a fresh fix budget', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true, checks: 'review', maxFixes: 1 }))
  toBuildChecks(d)
  d.check(false)
  d.reply('补了一次')
  d.check(false, '还是缺')
  assert.equal(d.task.status, 'waiting_user')
  assert.equal(d.task.pending, undefined)
  assert.equal(d.task.question?.source, 'loop')
  assert.equal(d.task.question?.node, 'build')
  assert.match(d.task.question!.text, /自动补齐 1 次后仍没有通过[\s\S]*还是缺/)
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '把改动写进 NOTES.md' })
  assert.equal(d.pending.purpose, 'fix')
  assert.equal(d.task.fixes, 0)
  assert.match(d.pending.prompt, /用户的指示[\s\S]*把改动写进 NOTES\.md/)
})

test('maxFixes 0 asks the user on the first failure', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false, checks: 'only', maxFixes: 0 }))
  toBuildChecks(d)
  d.check(false)
  assert.equal(d.task.status, 'waiting_user')
})

test('a failing test in a review dialog goes back to the developer as a round, and the reviewer only sees passing rounds', () => {
  const d = new Driver(workflow({ maxRounds: 3, escalate: true, checks: 'review' }))
  toBuildChecks(d)
  d.check(true)
  d.check(false, 'sum.test.ts: expected 3, got 4')
  assert.equal(d.pending.purpose, 'respond')
  assert.equal(d.pending.session, 'build')
  assert.match(d.pending.prompt, /评审意见（第 1 轮）[\s\S]*npm test[\s\S]*expected 3, got 4/)
  d.reply('修了加法')
  assert.equal(d.task.dialog?.round, 2)
  assert.equal(d.checking.node, 'review', 'the tests run again before the reviewer')
  d.check(true)
  assert.equal(d.pending.purpose, 'critique')
  // 评审方这时第一次被请来（第 1 轮测试没过、开发改完才轮到它）：给它完整的第一条消息。
  assert.match(d.pending.prompt, /平台检查（本轮已通过）[\s\S]*npm test[\s\S]*# 需求[\s\S]*待评审：build 的说明\n\n修了加法/)
  d.reply(CHANGES)
  d.reply('补了测试')
  assert.equal(d.task.dialog?.round, 3)
  d.check(true)
  assert.match(d.pending.prompt, /第 3 轮：build 的回复[\s\S]*补了测试/, 'later rounds are replies in the reviewer’s own session')
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
  assert.deepEqual(d.task.log.filter(e => e.type === 'check').map(e => `${e.node}:${e.type === 'check' && e.results.every(r => r.passed)}`),
    ['build:true', 'review:false', 'review:true', 'review:true'])
})

test('a dialog with only checks passes a round without any reviewer call', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: false, checks: 'only' }))
  toBuildChecks(d)
  d.check(true)
  d.check(false)
  assert.match(d.pending.prompt, /检查没有通过（第 1 轮）/)
  d.reply('修好了')
  d.check(true)
  assert.equal(d.task.status, 'done')
  assert.ok(!d.task.log.some(e => e.type === 'call' && e.purpose === 'critique'))
  assert.ok(d.task.log.some(e => e.type === 'note' && e.node === 'review' && e.text === '第 2 轮通过'))
})

test('test failures count against maxRounds: exhausting them escalates to the upstream like review changes', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: true, checks: 'only' }))
  toBuildChecks(d)
  d.check(true)
  d.check(false, '2 个测试失败')
  assert.equal(d.pending.purpose, 'reconfirm')
  assert.equal(d.pending.session, 'plan')
  assert.match(d.pending.prompt, /最近一轮没通过的原因[\s\S]*2 个测试失败/)
})

test('check results must match the check run: replies, questions and wrong-sized results are rejected', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true, checks: 'review' }))
  toBuildChecks(d)
  const run = d.checking
  for (const e of [
    { kind: 'replied' as const, call: run.id, sessionId: 's', text: PASS, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1 },
    { kind: 'asked' as const, call: run.id, question: { id: 'x', text: '?' } },
    { kind: 'checked' as const, call: run.id, results: [], ms: 1 },
    { kind: 'checked' as const, call: 'c0' as never, results: [{ check: run.checks[0]!, passed: true, detail: '' }], ms: 1 },
  ]) {
    const step = reduce(d.task, e, 99)
    assert.equal(step.accepted, false, e.kind)
    assert.equal(step.task, d.task)
  }
  const failed = d.send({ kind: 'call_failed', call: run.id, error: 'worktree 不见了' })
  assert.equal(failed.status, 'failed')
  d.send({ kind: 'retry' })
  assert.equal(d.checking.id, run.id, 'retry runs the same checks again')
})

test('convention docs open every session once, before the role', () => {
  const d = new Driver(workflow({ maxRounds: 2, escalate: true }), [{ name: '研发约定', version: 3, content: '提交前必须跑测试' }])
  assert.match(d.pending.prompt, /^# 团队约定：研发约定（第 3 版）\n\n提交前必须跑测试[\s\S]*# 你的角色/)
  d.reply('方案')
  assert.match(d.pending.prompt, /团队约定：研发约定/, 'a new session gets the conventions too')
  d.reply('实现')
  assert.match(d.pending.prompt, /团队约定：研发约定/, 'so does the reviewer')
  d.reply(CHANGES)
  assert.doesNotMatch(d.pending.prompt, /团队约定/, 'not repeated in the developer’s existing session')
})

test('when round 1’s tests fail, the reviewer’s first message still carries the task, the request and the upstream output', () => {
  const d = new Driver(workflow({ maxRounds: 3, escalate: true, checks: 'review' }))
  d.reply('方案 PLAN-V1')
  d.reply('实现 v1')
  d.check(true)
  d.check(false)
  d.reply('修好了测试')
  d.check(true)
  assert.equal(d.pending.purpose, 'critique')
  assert.match(d.pending.prompt, /# 你的角色[\s\S]*# 任务\n\n评审[\s\S]*# 需求\n\n加一个求和函数[\s\S]*上游产出：plan\n\n方案 PLAN-V1[\s\S]*待评审：build 的说明\n\n修好了测试/)
})
