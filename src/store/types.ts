// 存储层对外的数据类型（纯类型，前端也引用）。
import type { Event, TaskStatus } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'

/** 谁发出的事件：命令行、Web 页面、runner 自己、执行器（agent 回复或提问）。 */
export type Actor = 'cli' | 'web' | 'runner' | 'executor'

export type EventRow = { seq: number; at: number; actor: Actor; event: Event | { kind: 'created' }; accepted: boolean; reason?: string }

export type TaskSummary = { id: string; status: TaskStatus; request: string; workflow: string; createdAt: number; updatedAt: number }

export type TraceRow = { call: string; seq: number; event: TraceEvent }

export type TaskMeta = { repo: string; worktree: string; branch: string; baseSha: string }
