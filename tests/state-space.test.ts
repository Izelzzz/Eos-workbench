// 对真实的 reduce 做显式状态穷举：从 startTask 出发，在每个可达状态上尝试全部事件。
// 维护方法见 .claude/skills/verify-stage-state-machine/SKILL.md。
import { expect, test } from 'claude-code/testing'

import type { StageId, Task } from '../types'
import { STAGES, agentToStop, emptyRun, reduce, startTask } from '../hooks/core/pipeline'
import type { Action, Event, MachineConfig } from '../hooks/core/pipeline'

const AGENT_STAGES: readonly StageId[] = ['spec', 'dev', 'review']
const MAX_DEPTH = 30
const REASON = '命名不对'

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

const alphabet = (task: Task): Event[] => [
  { kind: 'finished', stage: task.current, ok: true, note: 'ok', durationMs: 1 },
  { kind: 'finished', stage: task.current, ok: false, note: '失败输出', durationMs: 1 },
  { kind: 'progress', stage: task.current, durationMs: 1 },
  { kind: 'approve' },
  { kind: 'reject', reason: REASON },
  { kind: 'reject', reason: '' },
  { kind: 'reject', reason: '   ' },
  { kind: 'retry' },
  { kind: 'skip', reason: '已手动完成' },
  { kind: 'abort' },
]

const label = (e: Event): string => {
  switch (e.kind) {
    case 'finished':
      return `finished(${e.stage}, ${e.ok ? 'ok' : 'fail'})`
    case 'progress':
      return `progress(${e.stage})`
    case 'reject':
    case 'skip':
      return `${e.kind}(${JSON.stringify(e.reason)})`
    default:
      return e.kind
  }
}

const feedbackShape = (f: string | undefined) => (f === undefined ? '-' : f.trim() === '' ? 'blank' : 'set')

/** 抽象状态：只保留影响控制流的字段。attempts 封顶 2 是因为 reduce 只区分「第 1 次」与「之后」。 */
const keyOf = (t: Task): string =>
  [
    t.status,
    t.current,
    t.rework,
    feedbackShape(t.feedback),
    ...STAGES.map(s => {
      const r = t.stages[s.id]
      return `${s.id}:${r.status}:${Math.min(r.attempts, 2)}:${r.agentId === undefined ? '' : 'a'}`
    }),
  ].join('|')

type Transition = { before: Task; event: Event; after: Task; action: Action; stopped: string | undefined }

type Invariant = {
  name: string
  harm: string
  /** 返回 false 表示这一步违反了不变量。 */
  holds: (s: Transition, config: MachineConfig) => boolean
}

const isRunning = (t: Task, id: StageId) => t.stages[id].status === 'running' && t.current === id
const blank = (reason: string) => reason.trim() === ''
const settledOk = (t: Task, id: StageId) => t.stages[id].status === 'passed' || t.stages[id].status === 'skipped'

const INVARIANTS: Invariant[] = [
  {
    name: '合并只发生在评审之后',
    harm: '未经评审的代码被合进基线分支，或任务在合并 / 部署没完成时就显示已完成。',
    holds: ({ after }) => {
      const merge = after.stages.merge.status
      if ((merge === 'running' || merge === 'passed') && !settledOk(after, 'review')) return false
      if (after.status === 'done' && !(settledOk(after, 'merge') && settledOk(after, 'deploy'))) return false
      return true
    },
  },
  {
    name: '不留孤儿子 agent',
    harm: '阶段已经不再等这个子 agent，它却在后台继续改 worktree、消耗额度。',
    holds: ({ before, event, after, stopped }) => {
      const run = before.stages[before.current]
      if (run.status !== 'running' || run.agentId === undefined) return true
      if (after.stages[before.current].agentId === run.agentId) return true
      return event.kind === 'finished' || stopped === run.agentId
    },
  },
  {
    name: 'progress 不改变阶段与状态',
    harm: '子 agent 中途的一个 turn 就把阶段判完，后续阶段读到半成品。',
    holds: ({ before, event, after }) =>
      event.kind !== 'progress' ||
      (after.current === before.current &&
        after.status === before.status &&
        STAGES.every(s => after.stages[s.id].status === before.stages[s.id].status)),
  },
  {
    name: '返工进入开发时必带反馈',
    harm: '开发 agent 不知道为什么被打回，只会原样再交一次，白白耗掉返工次数。',
    holds: ({ before, after }) =>
      !(isRunning(after, 'dev') && (before.current === 'test' || before.current === 'review' || before.current === 'merge')) ||
      (after.feedback !== undefined && !blank(after.feedback)),
  },
  {
    name: '空理由的驳回被拒绝',
    harm: '驳回没有理由，下一轮 agent 只能猜哪里不对。',
    holds: ({ before, event, after, action }) =>
      !(event.kind === 'reject' && blank(event.reason)) || (after === before && action.kind === 'none'),
  },
  {
    name: '返工次数不超过上限',
    harm: '测试或评审一直不过时无限循环，额度被耗光也停不下来。',
    holds: ({ after }, config) => after.rework <= config.maxRework,
  },
  {
    name: '合并前驳回回到评审并带上理由',
    harm: '人工指出的问题绕过评审直接进开发，或者理由丢失，评审者不会核实它。',
    holds: ({ before, event, after }) =>
      !(event.kind === 'reject' && !blank(event.reason) && before.status === 'waiting' && before.current === 'merge') ||
      (isRunning(after, 'review') && after.feedback?.includes(event.reason) === true),
  },
  {
    name: '评审只在合并前被驳回时才拿到反馈',
    harm: '开发返工用的测试输出或旧评审意见被当成「人工驳回理由」交给评审者。',
    holds: ({ before, after }) =>
      !(isRunning(after, 'review') && (before.current === 'dev' || before.current === 'test')) || after.feedback === undefined,
  },
]

const STUCK: Omit<Invariant, 'holds'> = {
  name: '没有卡死的状态',
  harm: '任务停在一个除了中止什么事件都推不动的状态，用户只能放弃它。',
}
const HARM = new Map([STUCK, ...INVARIANTS].map(i => [i.name, i.harm]))

type Exploration = {
  states: number
  truncated: number
  /** 每个被违反的不变量的最短反例：从 startTask 起的事件序列。 */
  violations: Record<string, string[]>
}

const explore = (config: MachineConfig): Exploration => {
  let now = 0
  let agents = 0
  const spawn = (task: Task, action: Action): Task =>
    action.kind === 'run' && AGENT_STAGES.includes(action.stage)
      ? { ...task, stages: { ...task.stages, [action.stage]: { ...task.stages[action.stage], agentId: `agent-${++agents}` } } }
      : task

  const start = startTask(draft(), now)
  const first = spawn(start.task, start.action)
  const paths = new Map<string, string[]>([[keyOf(first), []]])
  const violations: Record<string, string[]> = {}
  let frontier: Task[] = [first]
  let truncated = 0

  for (let depth = 0; frontier.length > 0; depth++) {
    const next: Task[] = []
    for (const before of frontier) {
      const path = paths.get(keyOf(before)) ?? []
      let movable = before.status === 'done' || before.status === 'aborted'
      for (const event of alphabet(before)) {
        const step = reduce(before, event, ++now, config)
        const stopped = agentToStop(before, step.task, event)
        const after = spawn(step.task, step.action)
        const here = [...path, label(event)]
        for (const inv of INVARIANTS) {
          if (violations[inv.name] === undefined && !inv.holds({ before, event, after, action: step.action, stopped }, config)) {
            violations[inv.name] = here
          }
        }
        const key = keyOf(after)
        if (event.kind !== 'abort' && key !== keyOf(before)) movable = true
        if (paths.has(key)) continue
        if (depth >= MAX_DEPTH) {
          truncated++
          continue
        }
        paths.set(key, here)
        next.push(after)
      }
      if (!movable && violations[STUCK.name] === undefined) violations[STUCK.name] = path
    }
    frontier = next
  }
  return { states: paths.size, truncated, violations }
}

const VARIANTS: { name: string; config: MachineConfig }[] = [
  { name: '完整配置', config: { maxRework: 2, hasTest: true, hasDeploy: true } },
  { name: '无测试', config: { maxRework: 2, hasTest: false, hasDeploy: true } },
  { name: '无部署', config: { maxRework: 2, hasTest: true, hasDeploy: false } },
  { name: '不允许返工', config: { maxRework: 0, hasTest: true, hasDeploy: true } },
]

/** 当前代码已知违反的不变量（Phase B 修复后清空）。 */
const FINDINGS = new Set(['空理由的驳回被拒绝', '合并前驳回回到评审并带上理由', '评审只在合并前被驳回时才拿到反馈'])

const results = VARIANTS.map(v => ({ ...v, ...explore(v.config) }))

for (const r of results) {
  test(`状态空间（${r.name}）：穷举 ${r.states} 个抽象状态，未触及深度上限`, () => {
    expect(r.truncated).toBe(0)
  })

  test(`状态空间（${r.name}）：不变量全部成立`, () => {
    const broken = Object.entries(r.violations)
      .filter(([name]) => !FINDINGS.has(name))
      .map(([name, path]) => ({ invariant: name, harm: HARM.get(name), counterexample: path.join(' → ') }))
    expect(broken).toEqual([])
  })
}

const findingIn = (variant: string, name: string) => results.find(r => r.name === variant)?.violations[name]

test('findings: 空理由的驳回被接受，Spec 带着空理由重写', () => {
  expect(findingIn('完整配置', '空理由的驳回被拒绝')).toEqual(['finished(spec, ok)', 'reject("")'])
})

test('findings: 合并前驳回回到开发而不是评审', () => {
  expect(findingIn('完整配置', '合并前驳回回到评审并带上理由')).toEqual([
    'finished(spec, ok)',
    'approve',
    'finished(dev, ok)',
    'finished(test, ok)',
    'finished(review, ok)',
    `reject("${REASON}")`,
  ])
})

test('findings: 无测试时，开发返工的反馈被带进评审', () => {
  expect(findingIn('完整配置', '评审只在合并前被驳回时才拿到反馈')).toBe(undefined)
  expect(findingIn('无测试', '评审只在合并前被驳回时才拿到反馈')).toEqual([
    'finished(spec, ok)',
    'approve',
    'finished(dev, ok)',
    'finished(review, fail)',
    'finished(dev, ok)',
  ])
})
