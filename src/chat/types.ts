// 对话 agent 的数据形状（纯类型，命令行和之后的网页共用）。
// 对话不属于任何任务：记录、trace 和用量都单独存，不混进任务的调用和指标。
import type { Usage } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'

/** 调用的用途名：trace 和指标里用它和任务的调用（produce、critique……）区分开。 */
export const CHAT_PURPOSE = 'chat'

/** 谁发的消息：和任务事件的 actor 同一套写法（命令行、网页）。登录做好之后换成具体的人。 */
export type ChatActor = 'cli' | 'web'

export type ChatSummary = { id: string; title: string; createdAt: number; updatedAt: number; actor: ChatActor; messages: number }

/** 一次模型调用的记录：用量、耗时、读了哪些数据（工具名和参数）。 */
export type ChatCall = { model?: string; usage: Usage; ms: number; reads: ChatRead[] }

/** agent 读了一次平台数据：工具名、参数，以及返回是否出错。页面上显示「读了哪些数据」用它。 */
export type ChatRead = { tool: string; args: string; isError: boolean }

/**
 * 对话里的一条记录，只追加。
 * - user：用户说的话；
 * - assistant：agent 的回复，带这次调用的记录；
 * - error：这一轮没有得到回复（调用失败、平台重启时调用没做完），带原因。之后照常可以接着说。
 */
export type ChatMessage =
  | { seq: number; at: number; role: 'user'; text: string; actor: ChatActor }
  | { seq: number; at: number; role: 'assistant'; text: string; call: ChatCall }
  | { seq: number; at: number; role: 'error'; text: string }

export type ChatDetail = ChatSummary & { log: ChatMessage[] }

/** 对话 agent 用的内置 Agent 模板（模型、effort、提示词从这里来，权限由平台定死）。 */
export const ASSISTANT_TEMPLATE = 'assistant'

/** agent 能提议的约定：工作流和 Agent 模板。 */
export type ProposalKind = 'workflow' | 'template'

/**
 * 对话里 agent 提出的约定修改，只记录、不生效。baseVersion：提议时这个约定的最新版本（新建的没有）。
 * call：提出它的那次调用（对话 trace 的 call id）。permissions：涉及的权限改动（入库时算好，确认时醒目列出），没有就是空数组。voided：那一轮被作废（agent 用了平台工具以外的工具）的原因，作废的提议不能保存。
 */
export type ChatProposal = {
  id: number
  chatId: string
  call: string
  at: number
  kind: ProposalKind
  name: string
  baseVersion?: number
  content: string
  rationale: string
  permissions: string[]
  voided?: string
  saved?: ProposalSaved
}

/** 提议被人确认保存后的记录：保存成的版本、操作人、时间。一条提议只保存一次。 */
export type ProposalSaved = { version: number; actor: ChatActor; at: number }

export type ChatTraceRow = { call: string; seq: number; event: TraceEvent }

/** 对话的用量汇总：只算这个对话自己的调用。 */
export type ChatMetrics = { purpose: typeof CHAT_PURPOSE; calls: number; failed: number; usage: Usage; agentMs: number; reads: number }

/**
 * 一条提议现在的状态（命令行 eos chat show 和网页共用）：
 * - saved / voided：保存过、作废了；
 * - unanswered：所在那一轮还没有回复（还在进行，或者没做完），现在不能保存；
 * - stale：目标约定已经不是提议基于的版本，保存会被拒；
 * - pending：可以保存。
 * permissions：涉及的权限改动（按现在的状态算），pending 和 stale 时给。code：确认码，只在 pending 且有权限改动时给。
 * current：目标约定现在的版本（新建的没有），用来显示差异。
 */
export type ProposalState = 'pending' | 'unanswered' | 'stale' | 'voided' | 'saved'
export type ProposalView = { proposal: ChatProposal; state: ProposalState; current?: { version: number; content: string }; permissions: string[]; code?: string }

/** 建一个任务要的三项：仓库、工作流、需求。 */
export type TaskInput = { repo: string; workflow: string; request: string }

/**
 * 对话里 agent 提出的新任务，只记录、不创建。title：卡片上的标题。input：agent 提的三项。
 * voided：那一轮被作废的原因，作废的不能创建。created：人确认创建后的记录。
 */
export type TaskProposal = {
  id: number
  chatId: string
  call: string
  at: number
  title: string
  input: TaskInput
  voided?: string
  created?: TaskCreated
}

/** 人确认创建的记录：建成的任务、操作人、时间，以及实际用的三项（人可能在卡片上改过）。一条提议只创建一次。 */
export type TaskCreated = { taskId: string; actor: ChatActor; at: number; input: TaskInput }

/**
 * 一条任务提议现在的状态（命令行和网页共用）：created / voided：创建过、作废了；unanswered：所在那一轮还没有回复，现在不能创建；pending：可以创建。
 */
export type TaskProposalState = 'pending' | 'unanswered' | 'voided' | 'created'
/** code：确认码，只在 pending 时给：命令行 eos chat create 要带上它，人得先在 eos chat show 里看过这条提议。 */
export type TaskProposalView = { proposal: TaskProposal; state: TaskProposalState; code?: string }
