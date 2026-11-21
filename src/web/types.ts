// Web 接口返回的数据类型（纯类型，前端也引用）。
import type { TaskMetrics } from '../engine/metrics.ts'
import type { Report } from '../engine/report.ts'
import type { Question, TaskStatus } from '../engine/types.ts'
import type { ConventionKind, ConventionRow, ConventionsUsed, ConventionSummary } from '../store/types.ts'
import type { Span } from '../trace/types.ts'

export type TaskDetail = {
  id: string
  status: TaskStatus
  workflow: string
  request: string
  position: string
  question?: Question
  failure?: string
  branch: string
  worktree: string
  report: Report
  /** 按阶段的 token 和时长构成，进行中的部分算到服务端处理请求的时刻。 */
  metrics: TaskMetrics
  trace: Span
  /** 有 runner 进程正在跑这个任务（看锁文件）。为 false 时回答对话尽头的问题后需要 resume。 */
  runnerAlive: boolean
  /** 创建任务时用的团队约定版本（第 1 块之前创建的任务没有）。 */
  conventions?: ConventionsUsed
}

export type AnswerRequest = { questionId: string; text: string }
export type AnswerResponse = { ok: true; resumeNeeded: boolean } | { ok: false; error: string }

export type CreateResponse = { ok: true; id: string } | { ok: false; error: string }
export type ActionResponse = { ok: true } | { ok: false; error: string }
export type WorkflowInfo = { name: string; version: number; description?: string; nodes: string[] }

/** 带位置的错误，例如 { path: 'nodes[2].with', message: '…' }。 */
export type FieldError = { path: string; message: string }

export type TemplateInfo = ConventionSummary & { description?: string; write?: 'none' | 'worktree' }
export type SkillInfo = ConventionSummary & { description?: string }
export type ConventionsResponse = { workflows: WorkflowInfo[]; docs: ConventionSummary[]; templates: TemplateInfo[]; skills: SkillInfo[] }
export type ConventionDetail = { kind: ConventionKind; name: string; versions: ConventionRow[] }
export type SaveConventionRequest = { content: string; note?: string; validateOnly?: boolean }
export type SaveConventionResponse = { ok: true; version?: number } | { ok: false; errors: FieldError[] } | { ok: false; error: string }
