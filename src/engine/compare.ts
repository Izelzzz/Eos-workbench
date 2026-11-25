// 改进前后对比：对某个约定的第 v 版（通常是批准提案生成的版本），比较用第 v-1 版的任务（改进前）和用第 v 版的任务（改进后）。
// 只比相邻两版：更早的版本和之后再改出来的版本都不算进来，变化才只来自这一次修改。纯函数。
// 只比较、不下因果结论：两组的需求不同、模型有随机性。任一组少于 MIN_SAMPLES 个任务时标「样本不足」。
import { signalsOf, type TargetKind } from './evidence.ts'
import type { TaskMetrics } from './metrics.ts'
import type { Task, TaskStatus } from './types.ts'
import { parseVerdict } from './verdict.ts'

export const MIN_SAMPLES = 3

type Versions = { name: string; version: number }[]
/** 任务用到的约定版本：和任务元数据里的 conventions 同形（只取用得到的字段）。 */
export type UsedVersions = { workflow?: { version?: number }; docs?: Versions; templates?: Versions; skills?: Versions }
export type CompareSample = { task: Task; metrics: TaskMetrics; used?: UsedVersions }

/** 一个任务的返工和成本。 */
export type TaskOutcome = {
  task: string
  version: number
  status: TaskStatus
  /** 输入 + 输出 token（不含缓存读写）。 */
  tokens: number
  agentMs: number
  /** 评审给出有效结论的次数（每一轮一次；格式无法解析而重来的不算）。 */
  reviews: number
  /** 没通过的检查结果条数。 */
  checkFailures: number
  /** agent 节点的补齐调用次数：交付物检查没通过后的补齐，以及检查次数用完、按用户指示的调整（引擎里都是 fix 调用）。 */
  fixes: number
  /** 归纳出的证据条数（评审要求修改、检查失败……，见 evidence.ts）。 */
  signals: number
}

export const OUTCOME_KEYS = ['tokens', 'agentMs', 'reviews', 'checkFailures', 'fixes', 'signals'] as const
export type OutcomeKey = (typeof OUTCOME_KEYS)[number]

export type Group = {
  /** 这一组的任务数（已完成和已中止的）。 */
  tasks: number
  /** 其中已完成的。完成率 = done / tasks。 */
  done: number
  /** 每个任务的平均值。 */
  mean: Record<OutcomeKey, number>
  outcomes: TaskOutcome[]
}

export type Comparison = {
  target: { kind: TargetKind; name: string }
  /** 改进后的版本 v；改进前是 v-1。 */
  version: number
  before: Group
  after: Group
  /** 两组都至少有 min 个任务。 */
  enough: boolean
  /** 每组至少要几个任务（MIN_SAMPLES），页面上提示用。 */
  min: number
  /** 用了这个约定但版本未知的任务（例如来自 YAML 文件的工作流），不计入两组。 */
  unknown: string[]
  /** 用 v-1 或 v 版、失败后还没处理的任务：还可能重试继续，数字不稳定，不计入两组。 */
  failed: string[]
}

/** 任务用的这个约定的版本；没用到返回 null，用到但版本未知返回 undefined。 */
export const versionUsed = (s: Pick<CompareSample, 'task' | 'used'>, kind: TargetKind, name: string): number | undefined | null => {
  const t = s.task
  const recorded = (list: Versions | undefined) => list?.find(x => x.name === name)?.version
  switch (kind) {
    case 'template': {
      const role = Object.values(t.workflow.roles).find(r => r.template?.name === name)
      // 快照里的角色没有模板信息（第 2 块之前的任务）时，退回任务元数据里记的模板版本。
      return role !== undefined ? role.template!.version : (recorded(s.used?.templates) ?? null)
    }
    case 'doc': {
      const d = t.docs.find(x => x.name === name)
      return d !== undefined ? d.version : (recorded(s.used?.docs) ?? null)
    }
    case 'skill':
      if (!Object.values(t.workflow.roles).some(r => r.skills.includes(name))) return null
      return recorded(s.used?.skills)
    case 'workflow':
      return t.workflow.name === name ? s.used?.workflow?.version : null
  }
}

export const outcomeOf = (s: CompareSample, version: number): TaskOutcome => {
  const log = s.task.log
  return {
    task: s.task.id,
    version,
    status: s.task.status,
    tokens: s.metrics.total.usage.input + s.metrics.total.usage.output,
    agentMs: s.metrics.total.agentMs,
    reviews: log.filter(e => e.type === 'call' && e.purpose === 'critique' && parseVerdict(e.reply) !== undefined).length,
    checkFailures: log.reduce((n, e) => n + (e.type === 'check' ? e.results.filter(r => !r.passed).length : 0), 0),
    fixes: log.filter(e => e.type === 'call' && e.purpose === 'fix').length,
    signals: signalsOf(s.task).length,
  }
}

const group = (outcomes: TaskOutcome[]): Group => ({
  tasks: outcomes.length,
  done: outcomes.filter(o => o.status === 'done').length,
  mean: Object.fromEntries(OUTCOME_KEYS.map(k => [k, outcomes.length === 0 ? 0 : outcomes.reduce((a, o) => a + o[k], 0) / outcomes.length])) as Record<OutcomeKey, number>,
  outcomes,
})

/** 对约定 target 的第 version 版做前后对比：第 version-1 版的任务 vs 第 version 版的任务。进行中的任务不计入。 */
export const compare = (samples: CompareSample[], target: { kind: TargetKind; name: string }, version: number): Comparison => {
  const before: TaskOutcome[] = []
  const after: TaskOutcome[] = []
  const unknown: string[] = []
  const failed: string[] = []
  for (const s of samples) {
    const v = versionUsed(s, target.kind, target.name)
    if (v === null || s.task.status === 'running' || s.task.status === 'waiting_user') continue
    if (v === undefined) {
      unknown.push(s.task.id)
      continue
    }
    if (v !== version && v !== version - 1) continue
    if (s.task.status === 'failed') {
      failed.push(s.task.id)
      continue
    }
    ;(v === version ? after : before).push(outcomeOf(s, v))
  }
  const b = group(before)
  const a = group(after)
  return { target, version, before: b, after: a, enough: b.tasks >= MIN_SAMPLES && a.tasks >= MIN_SAMPLES, min: MIN_SAMPLES, unknown, failed }
}
