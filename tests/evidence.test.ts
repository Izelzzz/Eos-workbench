import assert from 'node:assert/strict'
import test from 'node:test'
import { clipText, evidence, signalsOf, SIGNAL_TEXT_MAX } from '../src/engine/evidence.ts'
import type { Task } from '../src/engine/types.ts'
import { zeroUsage } from '../src/engine/types.ts'
import type { Workflow } from '../src/workflow/types.ts'
import { ASK, CHANGES, Driver, GARBAGE, PASS, REVISE, workflow } from './helpers.ts'

/** 开发角色来自模板 developer 的第 version 版、带技能 write-changes；任务 id 为 id。 */
const wf = (version = 1, opts: Parameters<typeof workflow>[0] = { maxRounds: 2, escalate: true, checks: 'review' }): Workflow => {
  const w = workflow(opts)
  return { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version }, skills: ['write-changes'] } } }
}
const DOCS = [{ name: '研发约定', version: 3, content: '写测试' }]
const driver = (id: string, w: Workflow) => {
  const d = new Driver(w, DOCS)
  d.task = { ...d.task, id }
  return d
}

/** 一次补齐、一次评审要求修改、对话里检查失败打满轮次、上游重新确认先答错格式再给新方案，最后通过。 */
const bumpy = (id = 'a', version = 1): Task => {
  const d = driver(id, wf(version))
  d.reply('方案')
  d.reply('实现')
  d.check(false, '缺少章节：改动')
  d.reply('补上了')
  d.check(true)
  d.check(true) // 第 1 轮测试
  d.reply(CHANGES)
  d.reply('改好了')
  d.check(false, '2 个测试失败') // 第 2 轮测试没过 → 打满轮次 → 请 plan 重新确认
  d.reply(GARBAGE)
  d.reply(REVISE)
  d.reply('按新方案调整')
  d.check(true)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
  return d.task
}

/** 每条证据的 id 是 任务:下标[:子项]，并且指向类型对得上的日志条目（同一次 reduce 追加的几条日志时刻相同，只比时刻不够）。 */
const ENTRY_TYPE = { review_changes: 'call', format_retry: 'call', scope_reverted: 'call', check_failed: 'check', escalated: 'note', call_failed: 'note', stuck: 'question' } as const
const assertPointsAtLog = (task: Task, s: ReturnType<typeof signalsOf>) => {
  for (const x of s) {
    const e = task.log[x.entry]!
    assert.match(x.id, new RegExp(`^${task.id}:${x.entry}(:(\\d+|r))?$`))
    assert.equal(e.type, ENTRY_TYPE[x.kind], `${x.id} points at a ${e.type} entry`)
    assert.equal(x.at, e.at)
    if (e.type === 'call' || e.type === 'check' || e.type === 'note') assert.equal(x.node, e.node)
  }
}

const clean = (id: string, version = 1): Task => {
  const d = driver(id, wf(version))
  d.reply('方案')
  d.reply('实现')
  d.check(true)
  d.check(true)
  d.reply(PASS)
  assert.equal(d.task.status, 'done')
  return d.task
}

test('signals come from the engine log in order, each judged against the right role and traceable to its log entry', () => {
  const task = bumpy()
  const s = signalsOf(task)
  assert.deepEqual(s.map(x => [x.kind, x.node, x.role]), [
    ['check_failed', 'build', 'dev'],
    ['review_changes', 'review', 'dev'],
    ['check_failed', 'review', 'dev'],
    ['escalated', 'review', 'dev'],
    ['format_retry', 'review', 'planner'],
  ])
  assertPointsAtLog(task, s)
  assert.equal(new Set(s.map(x => x.id)).size, s.length, 'ids are unique')
  assert.match(s[0]!.text, /NOTES\.md.*没有通过\n缺少章节：改动/s)
  assert.match(s[1]!.text, /缺少测试\n1\. \[major\]：补测试/)
  assert.match(s[2]!.text, /npm test.*2 个测试失败/s)
  assert.match(s[4]!.text, /^重新确认的回复无法解析：我觉得还行/)
  assert.deepEqual(signalsOf(clean('c')), [], 'a task that went straight through has no signals')
})

test('each failing result of one check run is its own signal; passing results are not', () => {
  const d = driver('m', wf())
  d.reply('方案')
  d.reply('实现')
  const run = d.checking
  const two = { ...run, checks: [run.checks[0]!, { kind: 'run' as const, run: ['npm', 'run', 'lint'], timeoutSec: 60 }, { kind: 'run' as const, run: ['true'], timeoutSec: 5 }] }
  d.task = { ...d.task, pending: two }
  d.send({ kind: 'checked', call: run.id, ms: 1, results: [
    { check: two.checks[0]!, passed: false, detail: '缺文件' }, { check: two.checks[1]!, passed: false, detail: 'lint 报错' }, { check: two.checks[2]!, passed: true, detail: '' },
  ] })
  const s = signalsOf(d.task).filter(x => x.kind === 'check_failed')
  assert.deepEqual(s.map(x => x.id), ['m:2:0', 'm:2:1'])
})

test('questions at the end of the loop, reverted writes, unparsable reviews and failed calls are signals', () => {
  const d = driver('q', wf(1, { maxRounds: 1, escalate: false }))
  d.reply('方案')
  const build = d.pending
  d.send({ kind: 'replied', call: build.id, sessionId: 's-build', text: '实现', usage: zeroUsage(), ms: 1, reverted: ['package.json'] })
  d.reply(GARBAGE)
  d.send({ kind: 'call_failed', call: d.pending.id, error: '网络断了' })
  d.send({ kind: 'retry' })
  d.reply(CHANGES) // 只有 1 轮、没有上游 → 问用户
  assert.equal(d.task.status, 'waiting_user')
  const s = signalsOf(d.task)
  assert.deepEqual(s.map(x => [x.kind, x.node, x.role]), [
    ['scope_reverted', 'build', 'dev'],
    ['format_retry', 'review', 'rev'],
    ['call_failed', 'review', undefined],
    ['review_changes', 'review', 'dev'],
    ['stuck', 'review', 'dev'],
  ])
  assertPointsAtLog(d.task, s)
  assert.equal(s[0]!.text, '越界改动被撤销：package.json')
  assert.equal(s[2]!.text, '调用失败：网络断了')
})

test('long texts keep their beginning and end within the limit', () => {
  const long = `开头${'x'.repeat(5000)}结尾`
  const c = clipText(long)
  assert.ok(c.length <= SIGNAL_TEXT_MAX + 20, String(c.length))
  assert.ok(c.startsWith('开头') && c.endsWith('结尾'))
  assert.match(c, /省略 \d+ 字/)
  assert.equal(clipText('  短  '), '短')
  assert.equal(clipText('x'.repeat(100), 10), 'x'.repeat(10), 'a limit too small for the marker just cuts')
})

test('a review that asks for changes and also had writes reverted gives two signals with different ids', () => {
  const d = driver('r', wf(1, { maxRounds: 2, escalate: false }))
  d.reply('方案')
  d.reply('实现')
  const c = d.pending
  d.send({ kind: 'replied', call: c.id, sessionId: 's-review', text: CHANGES, usage: zeroUsage(), ms: 1, reverted: ['x.md'] })
  const s = signalsOf(d.task)
  assert.deepEqual(s.map(x => [x.id, x.kind, x.role]), [['r:2', 'review_changes', 'dev'], ['r:2:r', 'scope_reverted', 'rev']])
})

test('when the upstream decides to ask the user after reconfirming, the question is judged against the upstream role', () => {
  const d = driver('u', wf(1, { maxRounds: 1, escalate: true }))
  d.reply('方案')
  d.reply('实现')
  d.reply(CHANGES) // 1 轮用完 → 请 plan 重新确认
  d.reply(ASK)
  assert.equal(d.task.status, 'waiting_user')
  assert.deepEqual(signalsOf(d.task).map(x => [x.kind, x.role]), [['review_changes', 'dev'], ['escalated', 'dev'], ['stuck', 'planner']])
  assertPointsAtLog(d.task, signalsOf(d.task))
})

test('when an agent node runs out of fixes, the question is judged against that node’s role', () => {
  const d = driver('f', wf(1, { maxRounds: 1, escalate: false, checks: 'review', maxFixes: 1 }))
  d.reply('方案')
  d.reply('实现')
  d.check(false)
  d.reply('补了')
  d.check(false)
  assert.equal(d.task.status, 'waiting_user')
  assert.deepEqual(signalsOf(d.task).map(x => [x.kind, x.node, x.role]), [['check_failed', 'build', 'dev'], ['check_failed', 'build', 'dev'], ['stuck', 'build', 'dev']])
})

test('signals about another role go to that role’s own template, not the developer’s; a task given twice is rejected', () => {
  const base = wf(1, { maxRounds: 1, escalate: false })
  const w = { ...base, roles: { ...base.roles, rev: { ...base.roles.rev!, template: { name: 'reviewer', version: 7 } } } }
  const d = driver('v', w)
  d.reply('方案')
  d.reply('实现')
  d.reply(GARBAGE)
  const r = evidence([{ task: d.task }])
  const t = (name: string) => r.targets.find(x => x.kind === 'template' && x.name === name)!
  assert.deepEqual([t('reviewer').versions, t('reviewer').counts], [[7], { format_retry: 1 }])
  assert.deepEqual(t('developer').signals, [])
  assert.throws(() => evidence([{ task: d.task }, { task: d.task }]), /出现了两次/)
})

test('signals are attributed to the judged role’s template and skills, and to the workflow and docs; tasks without problems still count', () => {
  const r = evidence([
    { task: bumpy('a', 1), used: { workflow: { version: 4 }, skills: [{ name: 'write-changes', version: 2 }] } },
    { task: clean('b', 2), used: { workflow: { version: 5 }, skills: [{ name: 'write-changes', version: 2 }] } },
    { task: clean('c', 2) },
  ])
  assert.equal(r.signals.length, 5)
  const by = (kind: string, name: string) => r.targets.find(t => t.kind === kind && t.name === name)!
  const dev = by('template', 'developer')
  assert.deepEqual([dev.versions, dev.tasks, dev.affected, dev.signals.length], [[1, 2], 3, 1, 4])
  assert.deepEqual(dev.counts, { review_changes: 1, check_failed: 2, escalated: 1 })
  const skill = by('skill', 'write-changes')
  assert.deepEqual([skill.versions, skill.tasks, skill.signals], [[2], 3, dev.signals], 'version unknown for task c is left out')
  const flow = by('workflow', 't')
  assert.deepEqual([flow.versions, flow.tasks, flow.affected, flow.signals.length], [[4, 5], 3, 1, 5])
  assert.deepEqual(by('doc', '研发约定').signals, flow.signals)
  assert.deepEqual(flow.counts, { review_changes: 1, check_failed: 2, format_retry: 1, escalated: 1 })
  assert.deepEqual(r.targets.map(t => [t.kind, t.name]), [['doc', '研发约定'], ['workflow', 't'], ['template', 'developer'], ['skill', 'write-changes']])
})

test('a role written directly in the workflow attributes only to the workflow and docs; no samples, no targets', () => {
  const d = driver('p', wf(1, { maxRounds: 1, escalate: false }))
  d.reply('方案')
  d.reply('实现')
  d.reply(GARBAGE) // 评审方 rev 直接写在工作流里
  const r = evidence([{ task: d.task }])
  assert.deepEqual(r.signals.map(s => [s.kind, s.role]), [['format_retry', 'rev']])
  assert.deepEqual(r.targets.filter(t => t.signals.length > 0).map(t => [t.kind, t.name]), [['doc', '研发约定'], ['workflow', 't']])
  assert.deepEqual(evidence([]), { signals: [], targets: [] })
})
