// 存储层对外的数据类型（纯类型，前端也引用）。
import type { Event, TaskStatus, Usage } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { RemoteRepo } from '../forge/types.ts'

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

/** repo：worktree 所在的仓库（远程仓库时是平台数据目录里的镜像）。remote：任务来自托管平台上的仓库时，它是哪个仓库。 */
export type TaskMeta = { repo: string; worktree: string; branch: string; baseSha: string; remote?: RemoteRepo; conventions?: ConventionsUsed; skills?: SkillSnapshot[] }

export type ConventionKind = 'workflow' | 'doc' | 'template' | 'skill'

export type ConventionRow = { kind: ConventionKind; name: string; version: number; content: string; note: string; actor: string; createdAt: number }

export type ConventionSummary = { kind: ConventionKind; name: string; version: number; updatedAt: number }

/** 改进提案的状态：待审批、已批准（生成了约定的新版本）、已拒绝、已过期（目标约定在提案之后被改过）。 */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'stale'

/** 提案的状态变化，只追加。version：批准后生成的约定版本号。 */
export type ProposalEvent = { seq: number; at: number; status: ProposalStatus; actor: string; reason?: string; version?: number }

/** 生成这条提案的模型调用（第 3 块之前手工写入的提案没有）。 */
/** run：同一次生成的提案共用这次调用（usage、ms 是整次调用的，不是每条提案的）。 */
export type ProposalGenerator = { model?: string; usage: Usage; ms: number; run?: string }

export type ProposalInput = {
  target: { kind: ConventionKind; name: string }
  /** 提案基于目标约定的第几版。批准时目标已经不是这一版就过期。 */
  baseVersion: number
  /** 目标约定的完整新内容。 */
  content: string
  rationale: string
  /** 依据的证据 id（见 engine/evidence.ts）。 */
  evidence: string[]
  /** 生成提案时看的范围：工作流和任务。 */
  scope: { workflow: string; tasks: string[] }
  generator?: ProposalGenerator
  actor: string
}

export type ProposalRow = ProposalInput & { id: number; createdAt: number; status: ProposalStatus; events: ProposalEvent[] }

export type Decision =
  | { ok: true; row: ProposalRow }
  | { ok: false; reason: 'missing' | 'not_pending' | 'stale'; row?: ProposalRow }
  | { ok: false; reason: 'invalid'; errors: string[]; row: ProposalRow }
