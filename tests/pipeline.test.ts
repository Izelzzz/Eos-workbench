import { expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { compilePatterns, protectedMatch } from '../hooks/core/guard'
import { flowMetrics } from '../hooks/core/metrics'
import { STAGES, abandonedRun, emptyRun, isFinalAgentStatus, reduce, startTask } from '../hooks/core/pipeline'
import type { Action, Event, MachineConfig, RunRef } from '../hooks/core/pipeline'
import { reviewTask } from '../hooks/core/prompts'
import { parseVerdict } from '../hooks/core/verdict'

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

/** 还没认领运行的事件：finished / progress 发出时才带上 seq。 */
type Unsent =
  | Exclude<Event, RunRef>
  | Omit<Extract<Event, { kind: 'finished' }>, 'seq'>
  | Omit<Extract<Event, { kind: 'progress' }>, 'seq'>

/** finished / progress 默认属于该阶段当前这次运行；要模拟旧运行的迟到结果，直接给 reduce 传带 seq 的事件。 */
const send = (task: Task, event: Unsent): Event =>
  'stage' in event ? ({ ...event, seq: task.stages[event.stage].seq } as Event) : event

const step = (task: Task, event: Unsent, now: number, config = FULL) => reduce(task, send(task, event), now, config)

/** 依次喂事件，每个事件间隔 1000ms，返回最终任务与每步动作。 */
const play = (events: Unsent[], config = FULL) => {
  let now = 0
  let { task, action } = startTask(draft(), now)
  const actions: Action[] = [action]
  for (const event of events) {
    now += 1000
    ;({ task, action } = step(task, event, now, config))
    actions.push(action)
  }
  return { task, actions }
}

const ok = (stage: Task['current'], tokens = 0): Unsent => ({
  kind: 'finished',
  stage,
  ok: true,
  durationMs: 500,
  tokens: { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0 },
})
const bad = (stage: Task['current'], note: string): Extract<Unsent, { kind: 'finished' }> => ({ kind: 'finished', stage, ok: false, note, durationMs: 500 })

test('顺利路径：spec 批准、开发、测试、评审、合并批准、部署批准', () => {
  const { task, actions } = play([
    ok('spec', 10),
    { kind: 'approve' },
    ok('dev', 20),
    ok('test'),
    ok('review', 5),
    { kind: 'approve' },
    ok('merge'),
    { kind: 'approve' },
    ok('deploy'),
  ])
  expect(actions.map(a => (a.kind === 'run' || a.kind === 'wait' ? `${a.kind}:${a.stage}` : a.kind))).toEqual([
    'run:spec',
    'wait:spec',
    'run:dev',
    'run:test',
    'run:review',
    'wait:merge',
    'run:merge',
    'wait:deploy',
    'run:deploy',
    'done',
  ])
  expect(task.status).toBe('done')
  expect(task.firstPass).toEqual({ test: true, review: true })
  expect(task.stages.spec.waitMs).toBe(1000)
  expect(task.stages.merge.waitMs).toBe(1000)

  const m = flowMetrics(task, 99_999)
  expect(m.leadMs).toBe(9000)
  expect(m.processMs).toBe(3000)
  expect(m.waitMs).toBe(3000)
  expect(m.tokens.output).toBe(35)
  expect(m.firstPassRate).toBe(1)
})

test('评审不通过：带着意见回到开发，再次通过后继续', () => {
  const { task, actions } = play([ok('spec'), { kind: 'approve' }, ok('dev'), ok('test'), bad('review', '缺少边界处理')])
  expect(actions.at(-1)).toEqual({ kind: 'run', stage: 'dev' })
  expect(task.rework).toBe(1)
  expect(task.feedback).toContain('缺少边界处理')
  expect(task.stages.dev.attempts).toBe(2)
  expect(task.stages.review.status).toBe('pending')
  expect(task.firstPass.review).toBe(false)

  const after = step(step(step(task, ok('dev'), 10_000).task, ok('test'), 11_000).task, ok('review'), 12_000)
  expect(after.action).toEqual({ kind: 'wait', stage: 'merge' })
  expect(after.task.feedback).toBe(undefined)
  expect(after.task.firstPass.review).toBe(false)
  expect(after.task.stages.review.attempts).toBe(2)
})

test('返工次数用尽后任务失败，需要人工介入', () => {
  const { task, actions } = play(
    [ok('spec'), { kind: 'approve' }, ok('dev'), bad('test', 'x'), ok('dev'), bad('test', 'x'), ok('dev'), bad('test', 'x')],
  )
  expect(task.status).toBe('failed')
  expect(actions.at(-1)?.kind).toBe('failed')
  expect(task.rework).toBe(2)
  expect(task.feedback).toContain('单元测试未通过')

  const retried = step(task, { kind: 'retry' }, 99_000)
  expect(retried.action).toEqual({ kind: 'run', stage: 'dev' })
  expect(retried.task.rework).toBe(1)
  expect(retried.task.feedback).toContain('单元测试未通过')
})

test('未配置测试与部署时跳过对应阶段', () => {
  const config = { maxRework: 2, hasTest: false, hasDeploy: false }
  const { task, actions } = play([ok('spec'), { kind: 'approve' }, ok('dev'), ok('review'), { kind: 'approve' }, ok('merge')], config)
  expect(task.stages.test.status).toBe('skipped')
  expect(task.stages.deploy.status).toBe('skipped')
  expect(actions.at(-1)).toEqual({ kind: 'done' })
})

test('驳回：spec 重写、合并前回到评审、部署被跳过', () => {
  const spec = play([ok('spec'), { kind: 'reject', reason: '范围太大' }])
  expect(spec.actions.at(-1)).toEqual({ kind: 'run', stage: 'spec' })
  expect(spec.task.feedback).toContain('范围太大')

  const merge = play([ok('spec'), { kind: 'approve' }, ok('dev'), ok('test'), ok('review'), { kind: 'reject', reason: '命名不对' }])
  expect(merge.actions.at(-1)).toEqual({ kind: 'run', stage: 'review' })
  expect(merge.task.rework).toBe(0)
  expect(merge.task.feedback).toContain('命名不对')
  expect(merge.task.stages.merge.status).toBe('pending')

  const deploy = play([
    ok('spec'),
    { kind: 'approve' },
    ok('dev'),
    ok('test'),
    ok('review'),
    { kind: 'approve' },
    ok('merge'),
    { kind: 'reject', reason: '先不发' },
  ])
  expect(deploy.task.status).toBe('done')
  expect(deploy.task.stages.deploy.status).toBe('skipped')
})

test('开发失败直接失败；重试会重新运行当前阶段', () => {
  const { task } = play([ok('spec'), { kind: 'approve' }, bad('dev', '没有变更')])
  expect(task.status).toBe('failed')
  const retried = step(task, { kind: 'retry' }, 9000)
  expect(retried.action).toEqual({ kind: 'run', stage: 'dev' })
  expect(retried.task.status).toBe('running')
  expect(retried.task.stages.dev.attempts).toBe(2)
})

test('中止后忽略后续事件；过期的完成事件被忽略', () => {
  const { task } = play([{ kind: 'abort' }, ok('spec')])
  expect(task.status).toBe('aborted')
  const stale = play([ok('dev')])
  expect(stale.actions.at(-1)?.kind).toBe('none')
  expect(stale.task.current).toBe('spec')
})

test('评审结论解析：代码块、裸 JSON、blocker、不可解析', () => {
  expect(parseVerdict('结论如下\n```json\n{"verdict":"pass","summary":"ok","issues":[]}\n```').verdict).toBe('pass')
  expect(parseVerdict('{"verdict":"fail","issues":[{"message":"m","file":"a.ts"}]}').issues).toEqual([
    { severity: 'major', file: 'a.ts', message: 'm' },
  ])
  expect(parseVerdict('{"verdict":"pass","issues":[{"severity":"blocker","message":"x"}]}').verdict).toBe('fail')
  expect(parseVerdict('看起来不错').verdict).toBe('fail')
})

test('受保护命令', () => {
  const patterns = compilePatterns(['^make release'])
  for (const cmd of ['git push origin main', 'git -C x merge foo', 'npx wrangler deploy', 'gh pr merge 3', 'make release']) {
    expect(protectedMatch(cmd, patterns)).not.toBe(undefined)
  }
  for (const cmd of ['git status', 'git diff', 'npm test', 'echo pushed', 'git merge-base HEAD main', 'git commit -m "merge fix"']) {
    expect(protectedMatch(cmd, patterns)).toBe(undefined)
  }
  expect(compilePatterns(['(']).length).toBe(compilePatterns().length)
})

test('子 agent 中途的 turn 只累计用量，阶段继续运行，直到最终 turn 才完成', () => {
  const { task } = play([ok('spec'), { kind: 'approve' }])
  const tokens = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }
  const mid = step(task, { kind: 'progress', stage: 'dev', durationMs: 300, tokens }, 5000)
  expect(mid.action.kind).toBe('none')
  expect(mid.task.current).toBe('dev')
  expect(mid.task.stages.dev.status).toBe('running')
  expect(mid.task.stages.dev.tokens.input).toBe(100)
  expect(mid.task.stages.dev.durationMs).toBe(300)

  const end = step(mid.task, ok('dev', 50), 6000)
  expect(end.action).toEqual({ kind: 'run', stage: 'test' })
  expect(end.task.stages.dev.tokens.input).toBe(150)
  expect(end.task.stages.dev.durationMs).toBe(800)

  const stale = step(end.task, { kind: 'progress', stage: 'dev', durationMs: 1, tokens }, 7000)
  expect(stale.task).toBe(end.task)
})

test('只有终态的子 agent 才算结束', () => {
  for (const status of ['completed', 'failed', 'killed', undefined]) expect(isFinalAgentStatus(status)).toBe(true)
  for (const status of ['pending', 'running', 'waiting', 'idle']) expect(isFinalAgentStatus(status)).toBe(false)
})

const toMergeGate: Unsent[] = [ok('spec'), { kind: 'approve' }, ok('dev'), ok('test'), ok('review')]
const skip = (reason = '已在主会话手动合并'): Unsent => ({ kind: 'skip', reason })

test('跳过失败的合并：标记为跳过并继续推进', () => {
  const failedMerge = [...toMergeGate, { kind: 'approve' } as Unsent, bad('merge', '冲突')]
  expect(play(failedMerge).task.status).toBe('failed')

  const { task, actions } = play([...failedMerge, skip()])
  expect(actions.at(-1)).toEqual({ kind: 'wait', stage: 'deploy' })
  expect(task.status).toBe('waiting')
  expect(task.endedAt).toBe(undefined)
  expect(task.stages.merge.status).toBe('skipped')
  expect(task.stages.merge.note).toContain('已在主会话手动合并')

  const noDeploy = play([...failedMerge, skip()], { ...FULL, hasDeploy: false })
  expect(noDeploy.actions.at(-1)).toEqual({ kind: 'done' })
  expect(noDeploy.task.status).toBe('done')
  expect(noDeploy.task.stages.merge.status).toBe('skipped')
  expect(noDeploy.task.stages.deploy.status).toBe('skipped')
})

test('跳过等待中的合并：计入等待时间并继续推进', () => {
  const { task, actions } = play([...toMergeGate, skip()])
  expect(actions.at(-1)).toEqual({ kind: 'wait', stage: 'deploy' })
  expect(task.stages.merge.status).toBe('skipped')
  expect(task.stages.merge.waitMs).toBe(1000)
  expect(task.stages.merge.waitingSince).toBe(undefined)
})

test('不能跳过 Spec、开发、运行中的阶段和已完成的任务', () => {
  const refused = (events: Unsent[]) => {
    const before = play(events).task
    const after = step(before, skip(), 99_000)
    expect(after.action.kind).toBe('none')
    expect(after.action.kind === 'none' && after.action.reason).toBeTruthy()
    expect(after.task).toBe(before)
  }
  refused([ok('spec')])
  refused([ok('spec'), { kind: 'approve' }, bad('dev', '没有变更')])
  refused([...toMergeGate, { kind: 'approve' }])
  refused([...toMergeGate, { kind: 'approve' }, ok('merge'), { kind: 'approve' }, ok('deploy')])
})

const devRunning = (agentId = 'agent-1'): Task => {
  const { task } = play([ok('spec'), { kind: 'approve' }])
  return { ...task, stages: { ...task.stages, dev: { ...task.stages.dev, agentId } } }
}
const stopOn = (before: Task, event: Unsent) => abandonedRun(before, step(before, event, 99_000).task, send(before, event))

test('中止或重试运行中的阶段时，放弃这次运行并停止它的子 agent', () => {
  expect(stopOn(devRunning(), { kind: 'abort' })).toEqual({ stage: 'dev', seq: 1, agentId: 'agent-1' })
  expect(stopOn(devRunning(), { kind: 'retry' })).toEqual({ stage: 'dev', seq: 1, agentId: 'agent-1' })
})

test('中止或重试运行中的命令阶段时，放弃这次运行（引擎据此停掉命令）', () => {
  const testRunning = play([ok('spec'), { kind: 'approve' }, ok('dev')]).task
  expect(stopOn(testRunning, { kind: 'abort' })).toEqual({ stage: 'test', seq: 1, agentId: undefined })
  expect(stopOn(testRunning, { kind: 'retry' })).toEqual({ stage: 'test', seq: 1, agentId: undefined })
  const retriedTwice = step(step(testRunning, { kind: 'retry' }, 99_000).task, { kind: 'retry' }, 99_001).task
  expect(stopOn(retriedTwice, { kind: 'abort' })).toEqual({ stage: 'test', seq: 3, agentId: undefined })
})

test('重试运行中的测试后，旧进程的结果不算到新的这次运行上', () => {
  const running = play([ok('spec'), { kind: 'approve' }, ok('dev')]).task
  const retried = step(running, { kind: 'retry' }, 10_000)
  expect(retried.action).toEqual({ kind: 'run', stage: 'test' })

  const stale = reduce(retried.task, { ...bad('test', '旧进程：exit 1'), seq: running.stages.test.seq }, 11_000, FULL)
  expect(stale.action.kind).toBe('none')
  expect(stale.task.current).toBe('test')
  expect(stale.task.stages.test.status).toBe('running')
  expect(stale.task.stages.test.seq).toBe(2)
  expect(stale.task.stages.test.note).toBe(undefined)

  const fresh = step(stale.task, ok('test'), 12_000)
  expect(fresh.action).toEqual({ kind: 'run', stage: 'review' })
  expect(fresh.task.rework).toBe(0)
  expect(fresh.task.stages.test.status).toBe('passed')
})

test('运行已结束、仍在运行或阶段不在运行时，不放弃任何运行', () => {
  expect(stopOn(devRunning(), ok('dev'))).toBe(undefined)
  expect(stopOn(devRunning(), { kind: 'progress', stage: 'dev', durationMs: 1 })).toBe(undefined)
  expect(stopOn(play([ok('spec')]).task, { kind: 'abort' })).toBe(undefined)
})

test('合并前驳回：评审核实理由后，通过回到合并闸门，不通过带着评审意见回到开发', () => {
  const rejected = play([...toMergeGate, { kind: 'reject', reason: '命名不对' }]).task
  const passed = step(rejected, ok('review'), 99_000)
  expect(passed.action).toEqual({ kind: 'wait', stage: 'merge' })
  expect(passed.task.feedback).toBe(undefined)
  expect(passed.task.firstPass.review).toBe(true)

  const failed = step(rejected, bad('review', '命名确实不对'), 99_000)
  expect(failed.action).toEqual({ kind: 'run', stage: 'dev' })
  expect(failed.task.rework).toBe(1)
  expect(failed.task.feedback).toContain('命名确实不对')
})

test('驳回必须写理由', () => {
  for (const events of [[ok('spec')], toMergeGate]) {
    const before = play(events).task
    for (const reason of ['', '   ']) {
      const after = step(before, { kind: 'reject', reason }, 99_000)
      expect(after.task).toBe(before)
      expect(after.action).toEqual({ kind: 'none', reason: '驳回需要填写理由' })
    }
  }
})

test('评审提示词：有人工驳回理由时要求逐条核实', () => {
  const base = { specPath: 's', diffPath: 'd', worktree: 'w' }
  expect(reviewTask(base)).not.toContain('人工驳回理由')
  expect(reviewTask({ ...base, feedback: '合并前被驳回：命名不对' })).toContain('人工驳回理由（必须逐条核实）\n\n合并前被驳回：命名不对')
})
