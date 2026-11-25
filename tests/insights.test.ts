import assert from 'node:assert/strict'
import test from 'node:test'
import { insights, sampleAt } from '../src/engine/insights.ts'
import { taskMetrics } from '../src/engine/metrics.ts'
import type { Workflow } from '../src/workflow/types.ts'
import { Clock, PASS, workflow } from './helpers.ts'

/** 开发角色来自模板 developer 的第 version 版；name 是工作流名。 */
const wf = (version: number, name = 't'): Workflow => {
  const w = workflow({ maxRounds: 2, escalate: false })
  return { ...w, name, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version } } } }
}

/** 规划 plan ms，开发 build ms，评审一轮通过 review ms；规划中途等用户 wait ms。 */
const run = (id: string, w: Workflow, ms: { plan: number; build: number; review: number; wait?: number }) => {
  const c = new Clock('none', w, id)
  let at = 0
  if (ms.wait !== undefined) {
    c.send(100, { kind: 'asked', call: c.call, question: { id: 'q', text: '?' } })
    c.send(100 + ms.wait, { kind: 'answered', questionId: c.task.question!.id, text: '好' })
  }
  c.reply((at += ms.plan), ms.plan, '方案')
  c.reply((at += ms.build), ms.build, '实现')
  c.reply((at += ms.review), ms.review, PASS)
  assert.equal(c.task.status, 'done')
  return { task: c.task, metrics: taskMetrics(c.task, 1e9, 0) }
}

test('stages are summed across tasks of the same workflow and sorted by total time, with median, max and the slowest task', () => {
  const a = run('a', wf(1), { plan: 1000, build: 2000, review: 500 })
  const b = run('b', wf(2), { plan: 1000, build: 6000, review: 500 })
  const c = run('c', wf(2), { plan: 1000, build: 4000, review: 500 })
  const o = run('o', wf(1, 'other'), { plan: 9000, build: 100, review: 100 })
  const r = insights([a, b, c, o])
  assert.deepEqual(r.tasks, { total: 4, running: 0, waiting_user: 0, done: 4, failed: 0, aborted: 0 })
  assert.deepEqual(
    r.byStage.map(s => [s.workflow, s.node, s.wallMs]),
    [
      ['t', 'build', 12_000],
      ['other', 'plan', 9000],
      ['t', 'plan', 3000],
      ['t', 'review', 1500],
      ['other', 'build', 100],
      ['other', 'review', 100],
    ],
  )
  const build = r.byStage[0]!
  assert.deepEqual([build.tasks, build.calls, build.medianMs, build.maxMs, build.slowest.task, build.agentMs], [3, 3, 4000, 6000, 'b', 12_000])
  assert.equal(build.usage.input, 300)
  assert.deepEqual(
    r.byWorkflow.map(w => [w.workflow, w.tasks, w.wallMs, w.medianMs]),
    [
      ['t', 3, 16_500, 5500],
      ['other', 1, 9200, 9200],
    ],
  )
})

test('templates are compared across workflows and versions; roles written in the workflow are listed by workflow and role', () => {
  const r = insights([
    run('a', wf(1), { plan: 1000, build: 2000, review: 500 }),
    run('b', wf(2), { plan: 1000, build: 6000, review: 500 }),
    run('o', wf(3, 'other'), { plan: 10, build: 10, review: 10 }),
  ])
  const dev = r.byTemplate.find(x => x.name === 'developer')!
  assert.deepEqual([dev.template, dev.versions, dev.tasks, dev.calls, dev.agentMs], [true, [1, 2, 3], 3, 3, 8010])
  const planner = r.byTemplate.find(x => x.name === 't/planner')!
  assert.deepEqual([planner.template, planner.versions, planner.tasks, planner.agentMs], [false, [], 2, 2000])
  assert.ok(
    r.byTemplate.some(x => x.name === 'other/planner'),
    'roles of the same name in different workflows are not mixed',
  )
  assert.equal(r.byTemplate[0]!.name, 'developer', 'sorted by agent time')
})

test('the bottleneck of each workflow is its slowest stage, with its share and the part that dominates it', () => {
  const r = insights([run('a', wf(1), { plan: 5000, build: 1000, review: 500, wait: 4000 }), run('b', wf(1), { plan: 1000, build: 1000, review: 500 })])
  // plan：a 的调用 5000 中等用户 4000（agent 1000），b 1000 → 合计 6000，其中等用户 4000、agent 2000；所有阶段 6000 + 2000 + 1000 = 9000
  assert.deepEqual(
    r.bottlenecks.map(b => [b.workflow, b.node, b.wallMs, b.part, b.partMs]),
    [['t', 'plan', 6000, 'waitUserMs', 4000]],
  )
  assert.equal(r.bottlenecks[0]!.share, 6000 / 9000)
  assert.equal(r.byStage[0]!.agentMs, 2000)
})

test('a failed task nobody has retried is counted up to its failure, not up to now', () => {
  const c = new Clock('none', wf(1), 'f')
  c.reply(1000, 1000, '方案')
  c.send(3000, { kind: 'call_failed', call: c.call, error: '断了' })
  const day = 86_400_000
  assert.equal(sampleAt(c.task, day), 3000)
  const r = insights([{ task: c.task, metrics: taskMetrics(c.task, sampleAt(c.task, day), 0) }, run('ok', wf(1), { plan: 1000, build: 5000, review: 500 })])
  const build = r.byStage.find(s => s.node === 'build')!
  assert.deepEqual([build.blockedMs, build.maxMs, build.slowest.task], [0, 5000, 'ok'])
  assert.equal(r.tasks.failed, 1)
  const running = new Clock('none', wf(1), 'r')
  assert.equal(sampleAt(running.task, day), day, 'a running task is counted up to now')
})

test('no tasks: empty tables and no bottleneck; a task still running is counted at now', () => {
  assert.deepEqual(insights([]), { tasks: { total: 0, running: 0, waiting_user: 0, done: 0, failed: 0, aborted: 0 }, byWorkflow: [], byStage: [], byTemplate: [], bottlenecks: [] })
  const c = new Clock('none', wf(1), 'live')
  c.reply(1000, 1000, '方案')
  const r = insights([{ task: c.task, metrics: taskMetrics(c.task, 4000, 0) }])
  assert.equal(r.tasks.running, 1)
  assert.deepEqual(
    r.byStage.map(s => [s.node, s.wallMs, s.runningMs]),
    [
      ['build', 3000, 3000],
      ['plan', 1000, 0],
    ],
  )
})
