// 价值流指标与显示格式。
import type { StageStatus, Task, Tokens } from '../../types'
import { STAGES } from './pipeline'

export type FlowMetrics = {
  /** 从创建到结束（或现在）的总时长。 */
  leadMs: number
  /** 各阶段实际执行时长之和。 */
  processMs: number
  /** 等待人工批准的时长之和（含正在等待的部分）。 */
  waitMs: number
  /** 流动效率 = 执行 / 总时长。 */
  efficiency: number
  tokens: Tokens
  rework: number
  /** 一次通过率（%C/A）：test 与 review 首次运行通过的比例；没有数据为 undefined。 */
  firstPassRate?: number
}

export const flowMetrics = (task: Task, now: number): FlowMetrics => {
  const runs = STAGES.map(s => task.stages[s.id])
  const end = task.endedAt ?? now
  const leadMs = Math.max(0, end - task.createdAt)
  const processMs = runs.reduce(
    (sum, r) => sum + r.durationMs + (r.status === 'running' && r.startedAt !== undefined ? now - r.startedAt : 0),
    0,
  )
  const waitMs = runs.reduce(
    (sum, r) => sum + r.waitMs + (r.waitingSince !== undefined ? end - r.waitingSince : 0),
    0,
  )
  const tokens = runs.reduce(
    (t, r) => ({
      input: t.input + r.tokens.input,
      output: t.output + r.tokens.output,
      cacheRead: t.cacheRead + r.tokens.cacheRead,
      cacheWrite: t.cacheWrite + r.tokens.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  const passes = Object.values(task.firstPass).filter((v): v is boolean => v !== undefined)
  return {
    leadMs,
    processMs,
    waitMs,
    efficiency: leadMs === 0 ? 0 : processMs / leadMs,
    tokens,
    rework: task.rework,
    firstPassRate: passes.length === 0 ? undefined : passes.filter(Boolean).length / passes.length,
  }
}

export const formatDuration = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export const formatTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`

/** 输入侧总量（未缓存 + 缓存读 + 缓存写）。 */
export const inputTotal = (t: Tokens): number => t.input + t.cacheRead + t.cacheWrite

export const STATUS_LABEL: Record<StageStatus, string> = {
  pending: '待执行',
  running: '运行中',
  waiting: '待批准',
  passed: '已完成',
  failed: '失败',
  skipped: '已跳过',
}

export const STATUS_ICON: Record<StageStatus, string> = {
  pending: '○',
  running: '◐',
  waiting: '⏸',
  passed: '●',
  failed: '✕',
  skipped: '–',
}

export const TASK_LABEL: Record<Task['status'], string> = {
  running: '进行中',
  waiting: '待批准',
  done: '已完成',
  failed: '失败',
  aborted: '已中止',
}
