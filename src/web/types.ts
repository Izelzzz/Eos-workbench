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
}
