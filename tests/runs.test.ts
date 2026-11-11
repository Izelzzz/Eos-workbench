// 每次运行的明细（StageRun.runs）：开始原因、结束、放弃、迟到的用量，以及累计值与明细的一致。
import { expect, test } from 'claude-code/testing'

import type { RunRecord, Task } from '../types'
import { flowMetrics } from '../hooks/core/metrics'
import { STAGES, annotateRun, emptyRun, reduce, startTask, versionedName, withArtifact } from '../hooks/core/pipeline'
import type { Event, MachineConfig, RunRef } from '../hooks/core/pipeline'

const FULL: MachineConfig = { maxRework: 2, hasTest: true, hasDeploy: true }

const draft = (): Task => ({
  id: 't1',
  title: '示例',
  request: '示例需求',
  createdAt: 0,
  updatedAt: 0,
  status: 'running',
  current: 'spec',
  stages: Object.fromEntries(STAGES.map(s => [s.id, emptyRun(s.id)])) as Task['stages'],
  rework: 0,
  firstPass: {},
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'devbench/t1', worktree: '/w' },
  dir: '/d',
})

type Unsent = Exclude<Event, RunRef> | (Omit<Extract<Event, { kind: 'finished' }>, 'seq'>)

const tokens = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 })
const ok = (stage: Task['current'], n = 0): Unsent => ({ kind: 'finished', stage, ok: true, durationMs: 500, tokens: tokens(n) })
const bad = (stage: Task['current'], note: string): Unsent => ({ kind: 'finished', stage, ok: false, note, durationMs: 500 })

const play = (events: Unsent[], config = FULL) => {
  let now = 0
  let { task } = startTask(draft(), now)
  for (const event of events) {
    now += 1000
    const sent = 'stage' in event ? ({ ...event, seq: task.stages[event.stage].seq } as Event) : event
    task = reduce(task, sent, now, config).task
  }
  return task
}

const shape = (runs: RunRecord[]) => runs.map(r => `${r.seq}:${r.cause}:${r.outcome}`)
const sum = (runs: RunRecord[]) =>
  runs.filter(r => r.outcome !== 'abandoned').reduce((acc, r) => ({ ms: acc.ms + r.durationMs, out: acc.out + r.tokens.output }), { ms: 0, out: 0 })

test('顺利路径：每个运行过的阶段一条 initial 记录，累计值和以前一样', () => {
  const task = play([ok('spec', 10), { kind: 'approve' }, ok('dev', 20), ok('test'), ok('review', 5), { kind: 'approve' }, ok('merge'), { kind: 'approve' }, ok('deploy')])
  for (const s of STAGES) {
    expect(shape(task.stages[s.id].runs)).toEqual(['1:initial:passed'])
    expect(sum(task.stages[s.id].runs)).toEqual({ ms: task.stages[s.id].durationMs, out: task.stages[s.id].tokens.output })
  }
  expect(task.stages.dev.runs[0]).toMatchObject({ attempt: 1, startedAt: 2000, endedAt: 3000, durationMs: 500 })
  const m = flowMetrics(task, 99_999)
  expect(m.processMs).toBe(3000)
  expect(m.tokens.output).toBe(35)
})

test('测试失败返工：开发的第二条记录是 rework，测试的第二条也是 rework', () => {
  const task = play([ok('spec'), { kind: 'approve' }, ok('dev'), bad('test', 'exit 1'), ok('dev')])
  expect(shape(task.stages.dev.runs)).toEqual(['1:initial:passed', '2:rework:passed'])
  expect(shape(task.stages.test.runs)).toEqual(['1:initial:failed', '2:rework:running'])
  expect(task.stages.test.runs[0]!.note).toBe('exit 1')
})

test('驳回：Spec 重写和合并前回到评审的记录是 reject', () => {
  expect(shape(play([ok('spec'), { kind: 'reject', reason: '范围太大' }]).stages.spec.runs)).toEqual(['1:initial:passed', '2:reject:running'])
  const merge = play([ok('spec'), { kind: 'approve' }, ok('dev'), ok('test'), ok('review'), { kind: 'reject', reason: '命名不对' }])
  expect(shape(merge.stages.review.runs)).toEqual(['1:initial:passed', '2:reject:running'])
  expect(merge.stages.merge.runs).toEqual([])
})

test('重试运行中的测试：旧记录 abandoned，新记录 retry；旧进程迟到的用量记到旧记录上，不进累计值', () => {
  const running = play([ok('spec'), { kind: 'approve' }, ok('dev')])
  const retried = reduce(running, { kind: 'retry' }, 10_000, FULL).task
  expect(shape(retried.stages.test.runs)).toEqual(['1:initial:abandoned', '2:retry:running'])
  expect(retried.stages.test.runs[0]).toMatchObject({ endedAt: 10_000, attempt: 1 })
  expect(retried.stages.test.runs[1]).toMatchObject({ attempt: 1, startedAt: 10_000 })

  const late = reduce(retried, { kind: 'finished', stage: 'test', seq: 1, ok: false, note: '旧进程', durationMs: 7000, tokens: tokens(3) }, 11_000, FULL)
  expect(late.action.kind).toBe('none')
  expect(late.task.stages.test.runs[0]).toMatchObject({ outcome: 'abandoned', durationMs: 7000, tokens: tokens(3) })
  expect(late.task.stages.test.runs[0]!.note).toBe('重试时放弃')
  expect(late.task.stages.test.durationMs).toBe(0)
  expect(late.task.stages.test.status).toBe('running')

  const done = reduce(late.task, { kind: 'finished', stage: 'test', seq: 2, ok: true, durationMs: 400 }, 12_000, FULL).task
  expect(shape(done.stages.test.runs)).toEqual(['1:initial:abandoned', '2:retry:passed'])
  expect(done.stages.test.durationMs).toBe(400)
  expect(sum(done.stages.test.runs).ms).toBe(400)
})

test('中止运行中的开发：记录 abandoned；中止后迟到的用量仍记到那次运行上', () => {
  const aborted = play([ok('spec'), { kind: 'approve' }, { kind: 'abort' }])
  expect(shape(aborted.stages.dev.runs)).toEqual(['1:initial:abandoned'])
  const late = reduce(aborted, { kind: 'progress', stage: 'dev', seq: 1, durationMs: 900, tokens: tokens(4) }, 9000, FULL).task
  expect(late.stages.dev.runs[0]).toMatchObject({ durationMs: 900, tokens: tokens(4) })
  expect(late.status).toBe('aborted')
})

test('已正常结束的那次运行再收到重复的结果：不再加用量', () => {
  const task = play([ok('spec'), { kind: 'approve' }, ok('dev'), bad('test', 'x')])
  const dup = reduce(task, { kind: 'finished', stage: 'dev', seq: 1, ok: true, durationMs: 500 }, 9000, FULL)
  expect(dup.task).toBe(task)
})

test('返工用尽后的人工重试：开发的新记录是 retry；失败后重试再批准的合并也是 retry', () => {
  const exhausted = play([ok('spec'), { kind: 'approve' }, ok('dev'), bad('test', 'x'), ok('dev'), bad('test', 'x'), ok('dev'), bad('test', 'x')])
  const retried = reduce(exhausted, { kind: 'retry' }, 99_000, FULL).task
  expect(shape(retried.stages.dev.runs).at(-1)).toBe('4:retry:running')

  const failedMerge = play([ok('spec'), { kind: 'approve' }, ok('dev'), ok('test'), ok('review'), { kind: 'approve' }, bad('merge', '冲突'), { kind: 'retry' }, { kind: 'approve' }])
  expect(shape(failedMerge.stages.merge.runs)).toEqual(['1:initial:failed', '2:retry:running'])
})

test('子 agent 启动后的配置和产物记到对应那次运行上', () => {
  const task = play([ok('spec'), { kind: 'approve' }])
  const ref = { stage: 'dev' as const, seq: 1 }
  const annotated = annotateRun(task, ref, { agentId: 'a1', model: 'opus', effort: 'high', skills: ['pstack:poteto-mode'] })
  expect(annotated.stages.dev.agentId).toBe('a1')
  expect(annotated.stages.dev.runs[0]).toMatchObject({ agentId: 'a1', model: 'opus', effort: 'high', skills: ['pstack:poteto-mode'] })

  const once = withArtifact(annotated, ref, '02-diff.patch', true)
  const twice = withArtifact(once, ref, '02-diff.patch', true)
  expect(twice.stages.dev.artifacts).toEqual(['02-diff.patch'])
  expect(twice.stages.dev.runs[0]!.artifacts).toEqual(['02-diff-1.patch'])
  expect(withArtifact(twice, ref, '02-dev-notes-1.md').stages.dev.runs[0]!.artifacts).toEqual(['02-diff-1.patch', '02-dev-notes-1.md'])
  expect(versionedName('06-deploy.log', 2)).toBe('06-deploy-2.log')
})
