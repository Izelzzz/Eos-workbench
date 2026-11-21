// 改进前后对比：对某个约定的第 v 版，把用了这个约定、已经结束的任务按任务快照里的版本分成两组——
// 版本 < v 是「改进前」，≥ v 是「改进后」——比较每个任务的成本和返工。纯函数。
// 只比较、不下因果结论：两组的需求不同、模型有随机性。任一组少于 MIN_SAMPLES 个任务时标「样本不足」。
import { signalsOf, type TargetKind, type VersionsUsed } from './evidence.ts'
import type { TaskMetrics } from './metrics.ts'
import type { Task, TaskStatus } from './types.ts'

export const MIN_SAMPLES = 3

/** 任务用到的约定版本：和任务元数据里的 conventions 同形（只取用得到的字段）。 */
export type CompareSample = { task: Task; metrics: TaskMetrics; used?: VersionsUsed & { docs?: { name: string; version: number }[]; templates?: { name: string; version: number }[] } }

/** 一个任务的返工和成本。 */
export type TaskOutcome = {
  task: string
  version: number
  status: TaskStatus
  /** 输入 + 输出 token（不含缓存读）。 */
  tokens: number
  agentMs: number
  /** 评审调用次数（每一轮评审一次，含格式重试）。 */
  reviews: number
  /** 没通过的检查结果条数。 */
  checkFailures: number
  /** 交付物检查没通过后的补齐次数。 */
  fixes: number
  /** 归纳出的证据条数（评审要求修改、检查失败……，见 evidence.ts）。 */
  signals: number
}

export const OUTCOME_KEYS = ['tokens', 'agentMs', 'reviews', 'checkFailures', 'fixes', 'signals'] as const
export type OutcomeKey = (typeof OUTCOME_KEYS)[number]

export type Group = {
  tasks: number
  /** 已完成 / 已结束（完成、失败、中止）。 */
  done: number
  mean: Record<OutcomeKey, number>
  median: Record<OutcomeKey, number>
  outcomes: TaskOutcome[]
}

export type Comparison = {
  target: { kind: TargetKind; name: string }
  version: number
  before: Group
  after: Group
  /** 两组都至少有 min 个任务。 */
  enough: boolean
  /** 每组至少要几个任务（MIN_SAMPLES），页面上提示用。 */
  min: number
  /** 用了这个约定但版本未知的任务（例如来自 YAML 文件的工作流），不计入两组。 */
  unknown: string[]
}

const FINISHED = new Set<TaskStatus>(['done', 'failed', 'aborted'])

/** 任务用的这个约定的版本；没用到返回 null，用到但版本未知返回 undefined。 */
export const versionUsed = (s: CompareSample, kind: TargetKind, name: string): number | undefined | null => {
  const t = s.task
  switch (kind) {
    case 'template': {
      const roles = Object.values(t.workflow.roles).filter(r => r.template?.name === name)
      return roles.length === 0 ? null : roles[0]!.template!.version
    }
    case 'doc': {
      const d = t.docs.find(x => x.name === name)
      return d === undefined ? null : d.version
    }
    case 'skill': {
      if (!Object.values(t.workflow.roles).some(r => r.skills.includes(name))) return null
      return s.used?.skills?.find(k => k.name === name)?.version
    }
    case 'workflow':
      return t.workflow.name === name ? s.used?.workflow?.version : null
  }
}

export const outcomeOf = (s: CompareSample, version: number): TaskOutcome => {
  const log = s.task.log
  return {
    task: s.task.id, version, status: s.task.status,
    tokens: s.metrics.total.usage.input + s.metrics.total.usage.output,
    agentMs: s.metrics.total.agentMs,
    reviews: log.filter(e => e.type === 'call' && e.purpose === 'critique').length,
    checkFailures: log.reduce((n, e) => n + (e.type === 'check' ? e.results.filter(r => !r.passed).length : 0), 0),
    fixes: log.filter(e => e.type === 'call' && e.purpose === 'fix').length,
    signals: signalsOf(s.task).length,
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length === 0 ? 0 : s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const group = (outcomes: TaskOutcome[]): Group => ({
  tasks: outcomes.length,
  done: outcomes.filter(o => o.status === 'done').length,
  mean: Object.fromEntries(OUTCOME_KEYS.map(k => [k, outcomes.length === 0 ? 0 : outcomes.reduce((a, o) => a + o[k], 0) / outcomes.length])) as Record<OutcomeKey, number>,
  median: Object.fromEntries(OUTCOME_KEYS.map(k => [k, median(outcomes.map(o => o[k]))])) as Record<OutcomeKey, number>,
  outcomes,
})

/** 对约定 target 的第 version 版做前后对比。进行中的任务不计入。 */
export const compare = (samples: CompareSample[], target: { kind: TargetKind; name: string }, version: number): Comparison => {
  const before: TaskOutcome[] = []
  const after: TaskOutcome[] = []
  const unknown: string[] = []
  for (const s of samples) {
    if (!FINISHED.has(s.task.status)) continue
    const v = versionUsed(s, target.kind, target.name)
    if (v === null) continue
    if (v === undefined) {
      unknown.push(s.task.id)
      continue
    }
    ;(v < version ? before : after).push(outcomeOf(s, v))
  }
  const b = group(before)
  const a = group(after)
  return { target, version, before: b, after: a, enough: b.tasks >= MIN_SAMPLES && a.tasks >= MIN_SAMPLES, min: MIN_SAMPLES, unknown }
}
