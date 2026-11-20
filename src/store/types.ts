// 存储层对外的数据类型（纯类型，前端也引用）。
import type { Event, TaskStatus } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'

/** 谁发出的事件：命令行、Web 页面、runner 自己、执行器（agent 回复或提问）。 */
export type Actor = 'cli' | 'web' | 'runner' | 'executor'

export type EventRow = { seq: number; at: number; actor: Actor; event: Event | { kind: 'created' }; accepted: boolean; reason?: string }

export type TaskSummary = { id: string; status: TaskStatus; request: string; workflow: string; createdAt: number; updatedAt: number }

export type TraceRow = { call: string; seq: number; event: TraceEvent }

/** 任务创建时用的团队约定版本。workflow.version 为 undefined 表示用的是平台外的 YAML 文件。第 2 块之前的任务没有 templates 和 skills。 */
export type ConventionsUsed = {
  workflow: { name: string; version?: number }
  docs: { name: string; version: number }[]
  templates?: { name: string; version: number }[]
  skills?: { name: string; version: number }[]
}

/** 任务创建时快照下来的技能内容（SKILL.md 全文）。执行时写成角色的技能目录，平台上之后的修改不影响这个任务。 */
export type SkillSnapshot = { name: string; version: number; content: string }

export type TaskMeta = { repo: string; worktree: string; branch: string; baseSha: string; conventions?: ConventionsUsed; skills?: SkillSnapshot[] }

export type ConventionKind = 'workflow' | 'doc' | 'template' | 'skill'

export type ConventionRow = { kind: ConventionKind; name: string; version: number; content: string; note: string; actor: string; createdAt: number }

export type ConventionSummary = { kind: ConventionKind; name: string; version: number; updatedAt: number }
