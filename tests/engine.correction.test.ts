// 修正入口：已完成的任务提交一条改正或补充，交给指定的 agent 节点在原来的会话里继续做；改完只重跑程序检查和平台动作。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { correctionChecks, describePosition, reduce } from '../src/engine/machine.ts'
import type { Event } from '../src/engine/types.ts'
import type { NodeId } from '../src/workflow/types.ts'
import { Driver, PASS, results, workflow } from './helpers.ts'

const correct = (node: string, text: string): Event => ({ kind: 'corrected', node: node as NodeId, text })

/** 走完：规划、开发（有交付物时检查通过）、评审（有测试时测试通过）、通过；有交付节点时推送成功。 */
const finish = (d: Driver, checks = false, ship = false) => {
  d.reply('方案 v1')
  d.reply('实现 v1')
  if (checks) {
    d.check(true)
    d.check(true)
  }
  d.reply(PASS)
  if (ship) d.check(true)
  assert.equal(d.task.status, 'done')
}

test('已完成的任务提交修正：交给指定节点原来的会话，不重跑别的节点；没有要重跑的检查时改完就回到完成', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false }))
  finish(d)
  const sessionsBefore = d.task.sessions
  const calls = d.task.log.filter(e => e.type === 'call').length
  d.send(correct('build', '再补一个负数的测试'))
  assert.equal(d.task.status, 'running')
  assert.deepEqual(d.task.correction, { round: 1, node: 'build', phase: 'work', fixes: 0 })
  assert.equal(d.pending.purpose, 'correct')
  assert.equal(d.pending.session, 'build', '原来的会话')
  assert.equal(d.pending.role, 'dev')
  assert.match(d.pending.prompt, /改正或补充（第 1 次修正）[\s\S]*再补一个负数的测试[\s\S]*不要从头重来/)
  assert.doesNotMatch(d.pending.prompt, /你的角色/, '会话已经有了，不重复角色说明')
  assert.match(describePosition(d.task), /第 1 次修正 · build · 修改中/)
  d.reply('补了负数的测试')
  assert.equal(d.task.status, 'done')
  assert.equal(d.task.correction, undefined)
  assert.equal(d.task.outputs.build, '实现 v1\n\n# 第 1 次修正\n\n补了负数的测试', '修正的回复接在原来的产出后面')
  assert.equal(d.task.sessions.build, sessionsBefore.build, '会话不变')
  assert.equal(d.task.log.filter(e => e.type === 'call').length, calls + 1, '只多了这一次修正调用')
  assert.ok(d.task.log.some(e => e.type === 'note' && e.text === '第 1 次修正完成'))
  assert.equal(describePosition(d.task), '已完成（修正过 1 次）')
  // 第二次修正：第几次加一。
  d.send(correct('plan', '方案里补一句为什么不支持字符串'))
  assert.equal(d.pending.session, 'plan')
  assert.match(d.pending.prompt, /第 2 次修正/)
  d.reply('补了')
  const entries = d.task.log.flatMap(e => (e.type === 'correction' ? [[e.round, e.node, e.text]] : []))
  assert.deepEqual(entries, [
    [1, 'build', '再补一个负数的测试'],
    [2, 'plan', '方案里补一句为什么不支持字符串'],
  ])
})

test('修正之后只重跑程序检查和平台动作（不再请评审）：检查没过交回修改，次数用完问用户；推送失败任务失败、重试时整轮重跑', () => {
  const wf = workflow({ maxRounds: 1, escalate: false, checks: 'review', maxFixes: 1, ship: 1 })
  assert.deepEqual(
    correctionChecks(wf, 'build' as NodeId).map(c => c.kind),
    ['file', 'run', 'platform'],
    '开发的交付物、评审和交付前的测试（去重）、最后推送',
  )
  assert.deepEqual(
    correctionChecks(wf, 'plan' as NodeId).map(c => c.kind),
    ['platform'],
    '修正方案：没有评审它的检查，只重新推送',
  )
  const d = new Driver(wf)
  finish(d, true, true)
  d.send(correct('build', '把函数名改成 total'))
  d.reply('改了函数名')
  assert.equal(d.checking.node, 'build')
  assert.deepEqual(d.checking.checks, correctionChecks(wf, 'build' as NodeId))
  // 测试没过：交回开发修（maxFixes 1 次），再没过问用户。
  d.check(false, '1 个测试失败')
  assert.equal(d.pending.purpose, 'correct')
  assert.match(d.pending.prompt, /修正之后，重跑检查没有通过[\s\S]*1 个测试失败/)
  d.reply('修了测试')
  d.check(false, '还是失败')
  assert.equal(d.task.status, 'waiting_user')
  assert.match(d.task.question?.text ?? '', /第 1 次修正（交给「build」）之后，重跑检查自动交回修改 1 次仍没有通过/)
  assert.equal(d.task.question?.node, 'build')
  d.send({ kind: 'answered', questionId: d.task.question!.id, text: '测试里的期望值写错了，改测试' })
  assert.equal(d.pending.purpose, 'correct')
  assert.match(d.pending.prompt, /用户的指示[\s\S]*改测试/)
  d.reply('改了测试的期望值')
  // 程序检查都过了、推送没成功：任务失败，挂着整轮检查等重试。
  const run = d.checking
  d.send({ kind: 'checked', call: run.id, results: results(run, 'platform', '远程分支被别人改过'), ms: 1 })
  assert.equal(d.task.status, 'failed')
  assert.match(d.task.failure ?? '', /第 1 次修正的/)
  assert.ok(d.task.pending !== undefined && d.task.pending.purpose === 'check' && d.task.pending.id !== run.id)
  d.send({ kind: 'retry' })
  d.check(true)
  assert.equal(d.task.status, 'done')
  assert.ok(!d.task.log.slice(d.task.log.findIndex(e => e.type === 'correction')).some(e => e.type === 'call' && e.purpose === 'critique'), '修正之后没有再请评审')
})

test('不接受的修正：任务没完成、交给对话节点或不存在的节点、内容为空；中止的任务什么都不接受', () => {
  const d = new Driver(workflow({ maxRounds: 1, escalate: false }))
  d.reply('方案 v1')
  assert.match(reduce(d.task, correct('build', '改一下'), 9).reason ?? '', /只有已完成的任务/)
  d.reply('实现 v1')
  d.reply(PASS)
  for (const [event, reason] of [
    [correct('review', '改一下'), /不是这个工作流里的 agent 节点，只能交给 agent 节点：plan、build/],
    [correct('nope', '改一下'), /不是这个工作流里的 agent 节点/],
    [correct('build', ' '), /不能为空/],
  ] as [Event, RegExp][]) {
    const step = reduce(d.task, event, 9)
    assert.equal(step.accepted, false)
    assert.match(step.reason ?? '', reason)
    assert.equal(step.task, d.task)
  }
  // 修正进行中不能再提交一条。
  d.send(correct('build', '改一下'))
  assert.match(reduce(d.task, correct('build', '再改一下'), 9).reason ?? '', /只有已完成的任务/)
  d.send({ kind: 'abort' })
  assert.equal(reduce(d.task, correct('build', '改一下'), 9).accepted, false)
})
