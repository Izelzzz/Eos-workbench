import assert from 'node:assert/strict'
import test from 'node:test'
import { compare, MIN_SAMPLES, type CompareSample } from '../src/engine/compare.ts'
import { taskMetrics } from '../src/engine/metrics.ts'
import type { Workflow } from '../src/workflow/types.ts'
import { CHANGES, Driver, PASS, workflow } from './helpers.ts'

/** 开发角色用 developer 模板第 v 版、技能 write-changes；带约定文档「研发约定」第 v 版。 */
const wf = (v: number): Workflow => {
  const w = workflow({ maxRounds: 2, escalate: false, checks: 'review' })
  return { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version: v }, skills: ['write-changes'] } } }
}

/** bumpy：一次补齐、评审要求修改一次；否则一次通过。open：停在第一个调用。 */
const sample = (id: string, v: number, kind: 'bumpy' | 'clean' | 'open', used: CompareSample['used'] = { workflow: { version: v }, skills: [{ name: 'write-changes', version: v }] }): CompareSample => {
  const d = new Driver(wf(v), [{ name: '研发约定', version: v, content: '' }])
  d.task = { ...d.task, id }
  if (kind !== 'open') {
    d.reply('方案')
    d.reply('实现')
    if (kind === 'bumpy') {
      d.check(false, '缺少章节')
      d.reply('补齐')
    }
    d.check(true)
    d.check(true) // 评审前的测试
    if (kind === 'bumpy') {
      d.reply(CHANGES)
      d.reply('改了')
      d.check(true)
    }
    d.reply(PASS)
    assert.equal(d.task.status, 'done')
  }
  return { task: d.task, metrics: taskMetrics(d.task, 1e9, 0), used }
}

test('tasks are split by the version they used: before the approved version and from it on, with per-task means and medians', () => {
  const samples = [
    sample('a1', 1, 'bumpy'), sample('a2', 1, 'bumpy'), sample('a3', 1, 'clean'),
    sample('b1', 2, 'clean'), sample('b2', 2, 'clean'), sample('b3', 3, 'bumpy'),
    sample('run', 2, 'open'),
  ]
  const c = compare(samples, { kind: 'template', name: 'developer' }, 2)
  assert.deepEqual(c.before.outcomes.map(o => [o.task, o.version]), [['a1', 1], ['a2', 1], ['a3', 1]])
  assert.deepEqual(c.after.outcomes.map(o => [o.task, o.version]), [['b1', 2], ['b2', 2], ['b3', 3]], 'later versions count as after; running tasks are left out')
  assert.equal(c.enough, true)
  const a1 = c.before.outcomes[0]!
  assert.deepEqual([a1.reviews, a1.checkFailures, a1.fixes, a1.signals], [2, 1, 1, 2])
  assert.deepEqual([c.before.mean.reviews, c.after.mean.reviews], [5 / 3, 4 / 3])
  assert.deepEqual([c.before.median.fixes, c.after.median.fixes], [1, 0])
  assert.deepEqual([c.before.mean.checkFailures, c.after.mean.checkFailures], [2 / 3, 1 / 3])
  assert.deepEqual([c.before.done, c.after.done], [3, 3])
  assert.equal(c.before.mean.tokens, c.before.outcomes.reduce((s, o) => s + o.tokens, 0) / 3)
  assert.ok(c.before.mean.tokens > 0 && c.before.mean.agentMs > 0)
})

test('fewer than the minimum in either group is not enough; doc, skill and workflow targets read their own versions; unknown versions are listed apart', () => {
  const samples = [sample('a1', 1, 'clean'), sample('a2', 1, 'clean'), sample('b1', 2, 'clean'), sample('y', 1, 'clean', {})]
  const t = compare(samples, { kind: 'template', name: 'developer' }, 2)
  assert.deepEqual([t.before.tasks, t.after.tasks, t.enough, MIN_SAMPLES], [3, 1, false, 3])
  const d = compare(samples, { kind: 'doc', name: '研发约定' }, 2)
  assert.deepEqual([d.before.tasks, d.after.tasks], [3, 1])
  const k = compare(samples, { kind: 'skill', name: 'write-changes' }, 2)
  assert.deepEqual([k.before.tasks, k.after.tasks, k.unknown], [2, 1, ['y']], 'a task without recorded skill versions is unknown, not guessed')
  const w = compare(samples, { kind: 'workflow', name: 't' }, 2)
  assert.deepEqual([w.before.tasks, w.after.tasks, w.unknown], [2, 1, ['y']])
  assert.deepEqual(compare(samples, { kind: 'doc', name: '别的文档' }, 2).before.tasks, 0, 'tasks not using the convention are left out')
  const empty = compare([], { kind: 'template', name: 'developer' }, 2)
  assert.deepEqual([empty.before.mean.tokens, empty.before.median.reviews, empty.enough], [0, 0, false])
})
