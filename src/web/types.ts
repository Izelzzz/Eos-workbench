// Web 接口返回的数据类型（纯类型，前端也引用）。
import type { Report } from '../engine/report.ts'
import type { Question, TaskStatus } from '../engine/types.ts'
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
  trace: Span
  /** 有 runner 进程正在跑这个任务（看锁文件）。为 false 时回答对话尽头的问题后需要 resume。 */
  runnerAlive: boolean
}

export type AnswerRequest = { questionId: string; text: string }
export type AnswerResponse = { ok: true; resumeNeeded: boolean } | { ok: false; error: string }

export type CreateResponse = { ok: true; id: string } | { ok: false; error: string }
export type ActionResponse = { ok: true } | { ok: false; error: string }
export type WorkflowInfo = { name: string; description?: string; nodes: string[] }
