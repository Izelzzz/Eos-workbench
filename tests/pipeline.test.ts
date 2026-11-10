import { expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { compilePatterns, protectedMatch } from '../hooks/core/guard'
import { flowMetrics } from '../hooks/core/metrics'
import { STAGES, emptyRun, reduce, startTask } from '../hooks/core/pipeline'
import type { Action, Event, MachineConfig } from '../hooks/core/pipeline'
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

/** 依次喂事件，每个事件间隔 1000ms，返回最终任务与每步动作。 */
const play = (events: Event[], config = FULL) => {
  let now = 0
  let { task, action } = startTask(draft(), now)
  const actions: Action[] = [action]
  for (const event of events) {
    now += 1000
    ;({ task, action } = reduce(task, event, now, config))
    actions.push(action)
  }
  return { task, actions }
}

const ok = (stage: Task['current'], tokens = 0): Event => ({
  kind: 'finished',
  stage,
  ok: true,
  durationMs: 500,
  tokens: { input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0 },
})
const bad = (stage: Task['current'], note: string): Event => ({ kind: 'finished', stage, ok: false, note, durationMs: 500 })

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

  const after = reduce(reduce(reduce(task, ok('dev'), 10_000, FULL).task, ok('test'), 11_000, FULL).task, ok('review'), 12_000, FULL)
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

  const retried = reduce(task, { kind: 'retry' }, 99_000, FULL)
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

test('驳回：spec 重写、合并前回到开发、部署被跳过', () => {
  const spec = play([ok('spec'), { kind: 'reject', reason: '范围太大' }])
  expect(spec.actions.at(-1)).toEqual({ kind: 'run', stage: 'spec' })
  expect(spec.task.feedback).toContain('范围太大')

  const merge = play([ok('spec'), { kind: 'approve' }, ok('dev'), ok('test'), ok('review'), { kind: 'reject', reason: '命名不对' }])
  expect(merge.actions.at(-1)).toEqual({ kind: 'run', stage: 'dev' })
  expect(merge.task.rework).toBe(1)

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
  const retried = reduce(task, { kind: 'retry' }, 9000, FULL)
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
