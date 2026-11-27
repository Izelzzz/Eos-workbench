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

/** agent 能提议的约定：工作流和 Agent 模板。 */
export type ProposalKind = 'workflow' | 'template'

/**
 * 对话里 agent 提出的约定修改，只记录、不生效。baseVersion：提议时这个约定的最新版本（新建的没有）。
 * call：提出它的那次调用（对话 trace 的 call id）。voided：那一轮被作废（agent 用了平台工具以外的工具）的原因，作废的提议不能保存。
 */
export type ChatProposal = { id: number; chatId: string; call: string; at: number; kind: ProposalKind; name: string; baseVersion?: number; content: string; rationale: string; voided?: string }

export type ChatTraceRow = { call: string; seq: number; event: TraceEvent }

/** 对话的用量汇总：只算这个对话自己的调用。 */
export type ChatMetrics = { purpose: typeof CHAT_PURPOSE; calls: number; failed: number; usage: Usage; agentMs: number; reads: number }
