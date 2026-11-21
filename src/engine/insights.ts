// 跨任务汇总阶段指标：按工作流、阶段、Agent 模板看成本和耗时，找出每个工作流最耗时的阶段和它的主要构成。纯函数。
import type { RoleMetrics, StageMetrics, TaskMetrics } from './metrics.ts'
import type { Task, TaskStatus, Usage } from './types.ts'
import { addUsage, zeroUsage } from './types.ts'

export type Sample = { task: Task; metrics: TaskMetrics }

/**
 * 统计时一个任务算到哪个时刻。进行中的任务算到 now；失败后没人处理的任务算到失败那一刻（它的最后一条记录），
 * 否则它的阻塞时长会一直涨，跨任务累加后把中位数、最长和瓶颈都拖偏。任务页上单看一个任务时仍然算到 now。
 */
export const sampleAt = (task: Task, now: number): number => (task.status === 'failed' ? task.log.at(-1)?.at ?? now : now)

/** 时长的组成部分，和阶段表一致。 */
export const PART_KEYS = ['agentMs', 'runningMs', 'checkMs', 'waitUserMs', 'blockedMs', 'overheadMs'] as const
export type PartKey = (typeof PART_KEYS)[number]
type Parts = Record<PartKey, number>

/** 一组样本（任务或阶段）的汇总：各部分是总和，median/max 是每个样本时长的中位数和最大值。 */
export type Bucket = Parts & {
  /** 有几个任务。 */
  tasks: number
  calls: number
  usage: Usage
  /** 所有样本的时长之和。 */
  wallMs: number
  medianMs: number
  maxMs: number
  /** 时长最长的那个样本属于哪个任务。 */
  slowest: { task: string; ms: number }
}

export type WorkflowBucket = Bucket & { workflow: string; betweenMs: number }
export type StageBucket = Bucket & { workflow: string; node: string }
export type TemplateBucket = {
  /** 模板名；直接写在工作流里的角色用「工作流/角色」，template 为 false。 */
  name: string
  template: boolean
  versions: number[]
  tasks: number
  calls: number
  usage: Usage
  agentMs: number
}
/** 一个工作流最耗时的阶段：它占这个工作流所有阶段时长的比例，以及占比最大的组成部分（打平时取 PART_KEYS 里靠前的）。 */
export type Bottleneck = { workflow: string; node: string; wallMs: number; share: number; part: PartKey; partMs: number }

export type Insights = {
  tasks: Record<TaskStatus, number> & { total: number }
  byWorkflow: WorkflowBucket[]
  byStage: StageBucket[]
  byTemplate: TemplateBucket[]
  bottlenecks: Bottleneck[]
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length === 0 ? 0 : s.length % 2 === 1 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}

type Item = { task: string; ms: number; calls: number; usage: Usage; parts: Parts }

const bucket = (items: Item[]): Bucket => {
  const parts = Object.fromEntries(PART_KEYS.map(k => [k, items.reduce((s, i) => s + i.parts[k], 0)])) as Parts
  const slowest = items.reduce((a, b) => (b.ms > a.ms ? b : a))
  return {
    ...parts,
    tasks: new Set(items.map(i => i.task)).size,
    calls: items.reduce((s, i) => s + i.calls, 0),
    usage: items.reduce((u, i) => addUsage(u, i.usage), zeroUsage()),
    wallMs: items.reduce((s, i) => s + i.ms, 0),
    medianMs: median(items.map(i => i.ms)),
    maxMs: slowest.ms,
    slowest: { task: slowest.task, ms: slowest.ms },
  }
}

const partsOf = (s: Parts): Parts => Object.fromEntries(PART_KEYS.map(k => [k, s[k]])) as Parts

const groupBy = <T>(xs: T[], key: (x: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>()
  for (const x of xs) {
    const k = key(x)
    const g = m.get(k)
    if (g === undefined) m.set(k, [x])
    else g.push(x)
  }
  return m
}

const byWall = <T extends { wallMs: number }>(a: T, b: T) => b.wallMs - a.wallMs

export const insights = (samples: Sample[]): Insights => {
  const statuses: TaskStatus[] = ['running', 'waiting_user', 'done', 'failed', 'aborted']
  const tasks = { total: samples.length, ...Object.fromEntries(statuses.map(s => [s, samples.filter(x => x.task.status === s).length])) } as Insights['tasks']

  const byWorkflow = [...groupBy(samples, s => s.task.workflow.name)].map(([workflow, xs]) => ({
    workflow,
    betweenMs: xs.reduce((s, x) => s + x.metrics.betweenMs, 0),
    ...bucket(xs.map(x => ({ task: x.task.id, ms: x.metrics.total.wallMs, calls: x.metrics.total.calls, usage: x.metrics.total.usage, parts: partsOf(x.metrics.total) }))),
  })).sort(byWall)

  const stageItems = samples.flatMap(x => x.metrics.stages.map(s => ({ workflow: x.task.workflow.name, task: x.task.id, stage: s })))
  const byStage = [...groupBy(stageItems, i => `${i.workflow}\u0000${i.stage.node}`)].map(([, xs]) => ({
    workflow: xs[0]!.workflow,
    node: xs[0]!.stage.node,
    ...bucket(xs.map(({ task, stage }: { task: string; stage: StageMetrics }) => ({ task, ms: stage.wallMs, calls: stage.calls, usage: stage.usage, parts: partsOf(stage) }))),
  })).sort(byWall)

  const roleItems = samples.flatMap(x => x.metrics.roles.map(r => ({ task: x.task.id, workflow: x.task.workflow.name, role: r })))
  const nameOf = (i: { workflow: string; role: RoleMetrics }) => i.role.template?.name ?? `${i.workflow}/${i.role.role}`
  const byTemplate = [...groupBy(roleItems, i => `${i.role.template === undefined ? 'r' : 't'}\u0000${nameOf(i)}`)].map(([, xs]) => ({
    name: nameOf(xs[0]!),
    template: xs[0]!.role.template !== undefined,
    versions: [...new Set(xs.flatMap(x => (x.role.template === undefined ? [] : [x.role.template.version])))].sort((a, b) => a - b),
    tasks: new Set(xs.map(x => x.task)).size,
    calls: xs.reduce((s, x) => s + x.role.calls, 0),
    usage: xs.reduce((u, x) => addUsage(u, x.role.usage), zeroUsage()),
    agentMs: xs.reduce((s, x) => s + x.role.agentMs, 0),
  })).sort((a, b) => b.agentMs - a.agentMs)

  const bottlenecks = byWorkflow.flatMap(w => {
    const stages = byStage.filter(s => s.workflow === w.workflow)
    const top = stages[0]
    const all = stages.reduce((s, x) => s + x.wallMs, 0)
    if (top === undefined || top.wallMs === 0) return []
    const part = PART_KEYS.reduce((a, b) => (top[b] > top[a] ? b : a))
    return [{ workflow: w.workflow, node: top.node, wallMs: top.wallMs, share: top.wallMs / all, part, partMs: top[part] }]
  })

  return { tasks, byWorkflow, byStage, byTemplate, bottlenecks }
}
