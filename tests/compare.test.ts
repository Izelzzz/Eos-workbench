import assert from 'node:assert/strict'
import test from 'node:test'
import { compare, MIN_SAMPLES, versionUsed, type CompareSample } from '../src/engine/compare.ts'
import { taskMetrics } from '../src/engine/metrics.ts'
import type { Workflow } from '../src/workflow/types.ts'
import { CHANGES, Driver, GARBAGE, PASS, workflow } from './helpers.ts'

/** 开发角色用 developer 模板第 v 版、技能 write-changes；带约定文档「研发约定」第 v 版。 */
const wf = (v: number): Workflow => {
  const w = workflow({ maxRounds: 2, escalate: false, checks: 'review' })
  return { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version: v }, skills: ['write-changes'] } } }
}

/** bumpy：一次补齐、评审要求修改一次；retry：评审第一次回复格式不对；clean：一次通过；open：停在第一个调用；failed：第一个调用失败。 */
const sample = (id: string, v: number, kind: 'bumpy' | 'clean' | 'retry' | 'open' | 'failed', used: CompareSample['used'] = { workflow: { version: v }, skills: [{ name: 'write-changes', version: v }] }): CompareSample => {
  const d = new Driver(wf(v), [{ name: '研发约定', version: v, content: '' }])
  d.task = { ...d.task, id }
  if (kind === 'failed') d.send({ kind: 'call_failed', call: d.pending.id, error: '网络断了' })
  else if (kind !== 'open') {
    d.reply('方案')
    d.reply('实现')
    if (kind === 'bumpy') {
      d.check(false, '缺少章节')
      d.reply('补齐')
    }
    d.check(true)
    d.check(true) // 评审前的测试
    if (kind === 'retry') d.reply(GARBAGE)
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

test('only the version right before and the approved version are compared; failed and running tasks stay out; format retries are not review rounds', () => {
  const samples = [
    sample('a1', 1, 'bumpy'), sample('a2', 1, 'bumpy'), sample('a3', 1, 'retry'),
    sample('b1', 2, 'clean'), sample('b2', 2, 'clean'), sample('b3', 2, 'bumpy'),
    sample('old', 0, 'bumpy'), sample('later', 3, 'clean'), sample('run', 2, 'open'), sample('f', 2, 'failed'),
  ]
  const c = compare(samples, { kind: 'template', name: 'developer' }, 2)
  assert.deepEqual(c.before.outcomes.map(o => o.task), ['a1', 'a2', 'a3'])
  assert.deepEqual(c.after.outcomes.map(o => o.task), ['b1', 'b2', 'b3'], 'versions other than 1 and 2 are not part of this change')
  assert.deepEqual([c.failed, c.enough, c.min], [['f'], true, MIN_SAMPLES])
  const [a1, , a3] = c.before.outcomes
  assert.deepEqual([a1!.reviews, a1!.checkFailures, a1!.fixes, a1!.signals], [2, 1, 1, 2])
  assert.deepEqual([a3!.reviews, a3!.signals], [1, 1], 'an unparsable review is a signal but not a review round')
  assert.deepEqual([c.before.mean.reviews, c.after.mean.reviews], [5 / 3, 4 / 3])
  assert.deepEqual([c.before.mean.fixes, c.after.mean.fixes], [2 / 3, 1 / 3])
  assert.deepEqual([c.before.done, c.after.done], [3, 3])
  assert.equal(c.before.mean.tokens, c.before.outcomes.reduce((s, o) => s + o.tokens, 0) / 3)
  assert.ok(c.before.mean.tokens > 0 && c.before.mean.agentMs > 0)
})

test('fewer than the minimum is not enough; doc, skill and workflow targets read their own versions; unknown versions are listed apart', () => {
  const samples = [sample('a1', 1, 'clean'), sample('a2', 1, 'clean'), sample('b1', 2, 'clean'), sample('y', 1, 'clean', {})]
  const t = compare(samples, { kind: 'template', name: 'developer' }, 2)
  assert.deepEqual([t.before.tasks, t.after.tasks, t.enough], [3, 1, false])
  assert.deepEqual([compare(samples, { kind: 'doc', name: '研发约定' }, 2).before.tasks, compare(samples, { kind: 'doc', name: '研发约定' }, 2).after.tasks], [3, 1])
  const k = compare(samples, { kind: 'skill', name: 'write-changes' }, 2)
  assert.deepEqual([k.before.tasks, k.after.tasks, k.unknown], [2, 1, ['y']], 'a task without recorded skill versions is unknown, not guessed')
  const w = compare(samples, { kind: 'workflow', name: 't' }, 2)
  assert.deepEqual([w.before.tasks, w.after.tasks, w.unknown], [2, 1, ['y']])
  assert.equal(compare(samples, { kind: 'doc', name: '别的文档' }, 2).before.tasks, 0, 'tasks not using the convention are left out')
  assert.deepEqual(compare([], { kind: 'template', name: 'developer' }, 2).before.mean.tokens, 0)
})

test('a task whose snapshot has no template info falls back to the versions recorded in its metadata', () => {
  const s = sample('old', 1, 'clean', { templates: [{ name: 'developer', version: 1 }] })
  const roles = Object.fromEntries(Object.entries(s.task.workflow.roles).map(([k, r]) => { const { template: _t, ...rest } = r; return [k, rest] }))
  const old = { ...s, task: { ...s.task, workflow: { ...s.task.workflow, roles } as Workflow } }
  assert.equal(versionUsed(old, 'template', 'developer'), 1)
  assert.equal(versionUsed({ ...old, used: {} }, 'template', 'developer'), null)
})
