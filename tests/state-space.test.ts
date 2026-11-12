// 对真实的 reduce 做显式状态穷举：从 startTask 出发，在每个可达状态上尝试全部事件。
// 维护方法见 .claude/skills/verify-stage-state-machine/SKILL.md。
import { expect, test } from 'claude-code/testing'

import type { RunRecord, StageId, Task } from '../types'
import { STAGES, abandonedRun, annotateRun, emptyRun, reduce, startTask } from '../hooks/core/pipeline'
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
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'eos/t1', worktree: '/w' },
  dir: '/d',
})

/** finished / progress 各发一份给当前这次运行，一份带着上一次运行的 seq（旧进程或旧 agent 的迟到结果）。 */
const alphabet = (task: Task): Event[] => {
  const seq = task.stages[task.current].seq
  return [
    ...[seq, seq - 1].flatMap((s): Event[] => [
      { kind: 'finished', stage: task.current, seq: s, ok: true, note: 'ok', durationMs: 1 },
      { kind: 'finished', stage: task.current, seq: s, ok: false, note: '失败输出', durationMs: 1 },
      { kind: 'progress', stage: task.current, seq: s, durationMs: 1 },
    ]),
    { kind: 'approve' },
    { kind: 'reject', reason: REASON },
    { kind: 'reject', reason: '' },
    { kind: 'reject', reason: '   ' },
    { kind: 'retry' },
    { kind: 'skip', reason: '已手动完成' },
    { kind: 'abort' },
  ]
}

const isStale = (task: Task, e: Event): boolean =>
  (e.kind === 'finished' || e.kind === 'progress') && e.seq !== task.stages[e.stage].seq

const label = (e: Event): string => {
  switch (e.kind) {
    case 'finished':
      return `finished(${e.stage}#${e.seq}, ${e.ok ? 'ok' : 'fail'})`
    case 'progress':
      return `progress(${e.stage}#${e.seq})`
    case 'reject':
    case 'skip':
      return `${e.kind}(${JSON.stringify(e.reason)})`
    default:
      return e.kind
  }
}

/** alphabet 只给当前阶段发迟到的结果（当前 seq 与上一次的），它们是否落地取决于那两条记录是不是 abandoned。 */
const lateTargets = (t: Task): string => {
  const r = t.stages[t.current]
  return [r.seq, r.seq - 1].map(seq => r.runs.find(x => x.seq === seq)?.outcome ?? '-').join(',')
}

const feedbackShape = (f: string | undefined) => (f === undefined ? '-' : f.trim() === '' ? 'blank' : 'set')

/**
 * 抽象状态：只保留影响控制流的字段。attempts 封顶 2 是因为 reduce 只区分「第 1 次」与「之后」。
 * 不记 seq：reduce 只比较事件的 seq 与当前的是否相等，alphabet 按当前 seq 生成新旧两种。
 * 记当前阶段这一次和上一次运行记录的 outcome：迟到的结果只记给 abandoned 的那条。
 */
const keyOf = (t: Task): string =>
  [
    t.status,
    t.current,
    t.rework,
    feedbackShape(t.feedback),
    lateTargets(t),
    ...STAGES.map(s => {
      const r = t.stages[s.id]
      return `${s.id}:${r.status}:${Math.min(r.attempts, 2)}:${r.agentId === undefined ? '' : 'a'}`
    }),
  ].join('|')

type Transition = { before: Task; event: Event; after: Task; action: Action; abandoned: ReturnType<typeof abandonedRun> }

type Invariant = {
  name: string
  harm: string
  /** 返回 false 表示这一步违反了不变量。 */
  holds: (s: Transition, config: MachineConfig) => boolean
}

const isRunning = (t: Task, id: StageId) => t.stages[id].status === 'running' && t.current === id
const blank = (reason: string) => reason.trim() === ''
const settledOk = (t: Task, id: StageId) => t.stages[id].status === 'passed' || t.stages[id].status === 'skipped'
/** 去掉运行明细与时间戳后的任务：流转状态与累计值。 */
const flow = (t: Task) =>
  JSON.stringify({ ...t, updatedAt: 0, stages: STAGES.map(s => ({ ...t.stages[s.id], runs: undefined })) })
const live = (runs: RunRecord[]) => runs.filter(r => r.outcome !== 'abandoned')

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
    name: '不留孤儿运行',
    harm: '阶段已经不再等这次运行，它的子 agent 或命令却在后台继续改 worktree、合并或部署。',
    holds: ({ before, event, after, abandoned }) => {
      const id = before.current
      const run = before.stages[id]
      if (run.status !== 'running') return true
      const same = after.current === id && after.stages[id].status === 'running' && after.stages[id].seq === run.seq
      if (same) return abandoned === undefined
      if (event.kind === 'finished') return true
      return abandoned?.stage === id && abandoned.seq === run.seq && abandoned.agentId === run.agentId
    },
  },
  {
    name: '过期的运行结果不改变任务的流转状态，只把用量记到对应那次运行上',
    harm: '旧进程或旧子 agent 迟到的结果被记到新的这次运行上，新结果丢失，任务带着旧输出返工；或者被放弃那次的真实用量丢失。',
    holds: ({ before, event, after, action }) => {
      if (!isStale(before, event) || (event.kind !== 'finished' && event.kind !== 'progress')) return true
      if (action.kind !== 'none' || flow(after) !== flow(before)) return false
      const old = before.stages[event.stage].runs.find(r => r.seq === event.seq)
      if (old?.outcome !== 'abandoned') return after === before
      const now = after.stages[event.stage].runs.find(r => r.seq === event.seq)
      return now?.durationMs === old.durationMs + event.durationMs && now.outcome === 'abandoned'
    },
  },
  {
    name: '每次开始的运行恰有一条记录',
    harm: '某次运行没有明细，时间线和被放弃运行的成本对不上。',
    holds: ({ after }) =>
      STAGES.every(s => {
        const r = after.stages[s.id]
        return JSON.stringify(r.runs.map(x => x.seq)) === JSON.stringify(Array.from({ length: r.seq }, (_, i) => i + 1))
      }),
  },
  {
    name: '至多一条运行中的记录，且就是当前运行',
    harm: '被停掉的运行在明细里仍显示运行中，或正在跑的那次没有记录可记用量。',
    holds: ({ after }) =>
      STAGES.every(s => {
        const r = after.stages[s.id]
        const running = r.runs.filter(x => x.outcome === 'running')
        if (isRunning(after, s.id)) return running.length === 1 && running[0]!.seq === r.seq
        return running.length === 0
      }),
  },
  {
    name: '累计值等于未放弃记录之和',
    harm: '面板上的耗时和 token 与明细对不上，或被放弃运行的用量混进了累计值。',
    holds: ({ after }) =>
      STAGES.every(s => {
        const r = after.stages[s.id]
        const runs = live(r.runs)
        const total = (k: keyof Task['stages']['spec']['tokens']) => runs.reduce((n, x) => n + x.tokens[k], 0)
        return (
          runs.reduce((n, x) => n + x.durationMs, 0) === r.durationMs &&
          (['input', 'output', 'cacheRead', 'cacheWrite'] as const).every(k => total(k) === r.tokens[k])
        )
      }),
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
      ? annotateRun(task, { stage: action.stage, seq: task.stages[action.stage].seq }, { agentId: `agent-${++agents}` })
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
        const abandoned = abandonedRun(before, step.task, event)
        const after = spawn(step.task, step.action)
        const here = [...path, label(event)]
        for (const inv of INVARIANTS) {
          if (violations[inv.name] === undefined && !inv.holds({ before, event, after, action: step.action, abandoned }, config)) {
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

const results = VARIANTS.map(v => ({ ...v, ...explore(v.config) }))

for (const r of results) {
  test(`状态空间（${r.name}）：穷举 ${r.states} 个抽象状态，未触及深度上限`, () => {
    expect(r.truncated).toBe(0)
  })

  test(`状态空间（${r.name}）：不变量全部成立`, () => {
    const broken = Object.entries(r.violations).map(([name, path]) => ({ invariant: name, harm: HARM.get(name), counterexample: path.join(' → ') }))
    expect(broken).toEqual([])
  })
}
