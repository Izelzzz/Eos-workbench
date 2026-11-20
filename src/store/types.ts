// 存储层对外的数据类型（纯类型，前端也引用）。
import type { Event, TaskStatus } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'

/** 谁发出的事件：命令行、Web 页面、runner 自己、执行器（agent 回复或提问）。 */
export type Actor = 'cli' | 'web' | 'runner' | 'executor'

export type EventRow = { seq: number; at: number; actor: Actor; event: Event | { kind: 'created' }; accepted: boolean; reason?: string }

export type TaskSummary = { id: string; status: TaskStatus; request: string; workflow: string; createdAt: number; updatedAt: number }

export type TraceRow = { call: string; seq: number; event: TraceEvent }

/** 任务创建时用的团队约定版本。workflow.version 为 undefined 表示用的是平台外的 YAML 文件。 */
export type ConventionsUsed = { workflow: { name: string; version?: number }; docs: { name: string; version: number }[] }

export type TaskMeta = { repo: string; worktree: string; branch: string; baseSha: string; conventions?: ConventionsUsed }

export type ConventionKind = 'workflow' | 'doc'

export type ConventionRow = { kind: ConventionKind; name: string; version: number; content: string; note: string; actor: string; createdAt: number }

export type ConventionSummary = { kind: ConventionKind; name: string; version: number; updatedAt: number }
