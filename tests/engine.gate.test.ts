// 卡点：人或 agent 验收某个上游节点；打回时交回它原来的会话修改，改完只重跑程序检查，再回到卡点。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describePosition, MAX_FORMAT_RETRIES, reduce } from '../src/engine/machine.ts'
import type { Event } from '../src/engine/types.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import { CHANGES, Driver, GARBAGE, PASS, workflow } from './helpers.ts'

/** 走到卡点：规划、开发、评审通过；有检查时开发的交付物检查和评审前的测试也都通过。 */
const toGate = (d: Driver, checks = false) => {
  d.reply('方案 v1')
  d.reply('实现 v1')
  if (checks) {
    d.check(true)
    d.check(true)
  }
  d.reply(PASS)
}

const decided = (d: Driver, pass: boolean, comment = ''): Event => ({ kind: 'decided', gate: d.task.gate!.node, round: d.task.gate!.round, pass, comment })

test('人验收：评审通过后停在卡点，状态是等待验收、写明在等谁，不挂任何工作；通过后任务完成', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false, gate: 'human' }))
  toGate(d)
  assert.equal(d.task.status, 'waiting_accept')
  assert.equal(d.task.pending, undefined)
  assert.equal(d.task.question, undefined)
  assert.deepEqual(d.task.gate, { node: 'accept', round: 1, phase: 'decide', fixes: 0, formatRetries: 0 })
  assert.match(describePosition(d.task), /accept 第 1 次验收 · 等待验收（任何能访问平台的人）/)
  assert.ok(d.task.log.some(e => e.type === 'note' && e.text === '第 1 次验收：等任何能访问平台的人验收「build」'))
  d.send(decided(d, true, '可以'))
  assert.equal(d.task.status, 'done')
  assert.equal(d.task.gate, undefined)
  const decision = d.task.log.find(e => e.type === 'decision')
  assert.deepEqual(decision?.type === 'decision' && { node: decision.node, round: decision.round, by: decision.by, pass: decision.pass, comment: decision.comment }, {
    node: 'accept',
    round: 1,
    by: 'human',
    pass: true,
    comment: '可以',
  })
})

test('人打回：意见交回开发原来的会话；改完（没有要重跑的检查）回到卡点，是第 2 次验收；不再请评审', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false, gate: 'human' }))
  toGate(d)
  d.send(decided(d, false, '缺少负数的测试'))
  assert.equal(d.task.status, 'running')
  assert.equal(d.pending.purpose, 'amend')
  assert.equal(d.pending.session, 'build', '交回被验收节点原来的会话')
  assert.equal(d.pending.role, 'dev')
  assert.match(d.pending.prompt, /验收没有通过（第 1 次验收，验收人：任何能访问平台的人）[\s\S]*缺少负数的测试/)
  assert.doesNotMatch(d.pending.prompt, /你的角色/, '已有会话不重复角色说明')
  d.reply('补了负数的测试')
  assert.equal(d.task.status, 'waiting_accept')
  assert.equal(d.task.gate?.round, 2)
  assert.equal(d.task.outputs.build, '补了负数的测试')
  d.send(decided(d, true))
  assert.equal(d.task.status, 'done')
  assert.deepEqual(d.purposes(), ['produce@plan', 'produce@build', 'critique@review', 'amend@accept'])
})

test('不接受的结论：空意见的打回、过期的那一次、别的卡点、不在等验收时', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false, gate: 'human' }))
  d.reply('方案 v1')
  const early = reduce(d.task, { kind: 'decided', gate: 'accept' as never, round: 1, pass: true, comment: '' }, 99)
  assert.equal(early.accepted, false, '还没到卡点')
  d.reply('实现 v1')
  d.reply(PASS)
  for (const [event, reason] of [
    [decided(d, false, '  '), /要写明意见/],
    [{ ...decided(d, true), round: 2 }, /不在等这次验收/],
    [{ ...decided(d, true), gate: 'review' }, /不在等这次验收/],
  ] as [Event, RegExp][]) {
    const step = reduce(d.task, event, 99)
    assert.equal(step.accepted, false)
    assert.match(step.reason ?? '', reason)
    assert.equal(step.task, d.task)
  }
  // 两个人同时看着第 1 次：一个打回之后，另一个对第 1 次的通过作废。
  const first = decided(d, true)
  d.send(decided(d, false, '再改改'))
  d.reply('改了')
  assert.equal(reduce(d.task, first, 99).accepted, false)
})

test('打回之后只重跑程序检查（被验收节点和它之后各节点的交付物、命令检查，去掉重复的，不含平台动作），通过后回到卡点', () => {
  const wf = workflow({ maxRounds: 1, escalate: false, checks: 'review', gate: 'human', gateFixes: 1, ship: 1 })
  const gate = wf.nodes.find(n => n.kind === 'gate')!
  assert.deepEqual(
    gate.checks.map(c => c.kind),
    ['file', 'run'],
  )
  const d = new Driver(wf)
  toGate(d, true)
  d.send(decided(d, false, '改一下命名'))
  d.reply('改了命名')
  assert.equal(d.checking.node, 'accept')
  assert.equal(d.checking.checks, gate.checks)
  assert.equal(d.task.gate?.phase, 'check')
  // 检查没通过：交回开发修（自动 1 次），再没通过就问用户。
  d.check(false, '1 个测试失败')
  assert.equal(d.pending.purpose, 'amend')
  assert.match(d.pending.prompt, /重跑检查没有通过[\s\S]*1 个测试失败/)
  d.reply('修了测试')
  d.check(false, '还是失败')
  assert.equal(d.task.status, 'waiting_user')
  assert.equal(d.task.question?.source, 'loop')
  assert.match(d.task.question?.text ?? '', /重跑检查自动交回修改 1 次仍没有通过[\s\S]*还是失败/)
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '把失败的用例删掉重写' })
  assert.equal(d.pending.purpose, 'amend')
  assert.match(d.pending.prompt, /用户的指示[\s\S]*删掉重写/)
  d.reply('重写了')
  d.check(true)
  assert.equal(d.task.status, 'waiting_accept')
  assert.equal(d.task.gate?.round, 1, '用户给出指示后从第 1 次重新计')
  d.send(decided(d, true))
  // 卡点之后才是交付：测试通过再推送。
  assert.equal(d.checking.node, 'ship')
  assert.ok(!d.task.log.some(e => e.type === 'call' && e.purpose === 'critique' && e.at > d.task.log.find(x => x.type === 'decision')!.at), '打回之后没有再请评审')
})

test('agent 验收：在卡点自己的会话里给结论；打回后开发修改，再在同一会话里复核；通过后完成', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false, gate: 'agent', gateRounds: 2 }))
  toGate(d)
  assert.equal(d.task.status, 'running')
  assert.equal(d.pending.purpose, 'accept')
  assert.equal(d.pending.session, 'accept')
  assert.equal(d.pending.role, 'rev')
  assert.match(d.pending.prompt, /你的角色[\s\S]*# 验收[\s\S]*上游产出：plan[\s\S]*待验收：build 的产出[\s\S]*实现 v1[\s\S]*"verdict"/)
  assert.match(describePosition(d.task), /等待验收（角色「rev」的 agent）/)
  d.reply(CHANGES)
  assert.equal(d.pending.purpose, 'amend')
  assert.equal(d.pending.session, 'build')
  assert.match(d.pending.prompt, /验收人：角色「rev」的 agent[\s\S]*补测试/)
  d.reply('补了测试')
  assert.equal(d.pending.purpose, 'accept')
  assert.doesNotMatch(d.pending.prompt, /你的角色/)
  assert.match(d.pending.prompt, /第 2 次验收：build 修改后的回复[\s\S]*补了测试/)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
  const decisions = d.task.log.flatMap(e => (e.type === 'decision' ? [`${e.round}:${e.by}:${e.pass}`] : []))
  assert.deepEqual(decisions, ['1:rev:false', '2:rev:true'])
})

test('agent 验收打回次数用完就问用户；回复格式不对时重新要求，次数用完任务失败', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false, gate: 'agent', gateRounds: 1 }))
  toGate(d)
  d.reply(CHANGES)
  assert.equal(d.task.status, 'waiting_user')
  assert.match(d.task.question?.text ?? '', /打回 1 次后仍没有通过[\s\S]*补测试/)
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '测试够了，改说明就行' })
  assert.equal(d.pending.purpose, 'amend')
  d.reply('改了说明')
  for (let i = 0; i < MAX_FORMAT_RETRIES; i++) {
    d.reply(GARBAGE)
    assert.match(d.pending.prompt, /无法解析成验收结论/)
  }
  d.reply(GARBAGE)
  assert.equal(d.task.status, 'failed')
  assert.equal(d.pending.purpose, 'accept', '保留一次新的要求，重试时接着跑')
})

test('没有卡点的工作流不会进入等待验收：内置 feature、standard 的节点里没有卡点', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  for (const name of ['feature', 'standard']) {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'workflow', 'templates', `${name}.yaml`), 'utf8')
    const r = parseWorkflow(source, () => ({ template: { name: 'x', model: 'm', prompt: 'p', write: 'worktree', writePaths: ['**'], denyTools: [], skills: [], mcp: [] }, version: 1 }))
    assert.ok(r.ok)
    assert.ok(!r.workflow.nodes.some(n => n.kind === 'gate'), name)
  }
})
