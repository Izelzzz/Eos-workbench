// 引擎的状态与事件。Task 是任务的唯一状态；pending 就是"下一个要执行的 agent 调用"（outbox），
// runner 执行它，把结果作为事件交回 reduce。
import type { NodeId, RoleId, Workflow } from '../workflow/types.ts'

declare const brand: unique symbol
export type CallId = string & { readonly [brand]: 'CallId' }

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * 调用的用途：
 * produce 一个 agent 节点完成工作；critique 评审给结论；respond 被评审方回应意见；
 * reconfirm 上游重新确认做法与需求；reapply 被评审方按修订方案调整；instruct 被评审方按用户指示调整。
 */
export type Purpose = 'produce' | 'critique' | 'respond' | 'reconfirm' | 'reapply' | 'instruct'

export type Call = {
  id: CallId
  /** 这次调用推进的是哪个节点。 */
  node: NodeId
  /** 在谁的会话里说话：agent 节点用自己的 id，对话节点的评审方用对话节点的 id。 */
  session: NodeId
  role: RoleId
  purpose: Purpose
  prompt: string
}

export type DialogPhase = 'critique' | 'respond' | 'reconfirm' | 'reapply' | 'instruct' | 'ask'

export type DialogState = {
  node: NodeId
  /** 当前是第几轮评审，从 1 开始，不超过 maxRounds。 */
  round: number
  /** 是否已经自动请上游重新确认过（每个对话节点只自动一次，之后改为问用户）。 */
  escalated: boolean
  phase: DialogPhase
  /** 当前这一步的回复无法解析时已重新要求的次数。 */
  formatRetries: number
  /** 最近一次评审意见，交给被评审方或上游时引用。 */
  lastCritique?: string
}

export type QuestionSource = 'agent' | 'loop'

export type Question = {
  id: string
  /** agent：调用进行中 agent 主动提问，调用挂起等回答；loop：对话循环走到尽头，需要用户指示。 */
  source: QuestionSource
  /** 提问时所在的节点。 */
  node?: NodeId
  call?: CallId
  text: string
  options?: string[]
}

export type TaskStatus = 'running' | 'waiting_user' | 'done' | 'failed' | 'aborted'

export type Entry =
  | { type: 'call'; at: number; call: CallId; node: NodeId; role: RoleId; purpose: Purpose; round?: number; prompt: string; reply: string; usage: Usage; ms: number; model?: string }
  | { type: 'question'; at: number; question: Question }
  | { type: 'answer'; at: number; questionId: string; text: string }
  | { type: 'note'; at: number; node?: NodeId; text: string }

export type Task = {
  id: string
  request: string
  /** 平台提供的环境说明（工作目录、基线提交、查看改动的方法），放进每个节点的上下文。 */
  context?: string
  workflow: Workflow
  status: TaskStatus
  /** 正在进行的节点下标；等于节点数时任务完成。 */
  cursor: number
  /** 每个 agent 节点的最新产出。 */
  outputs: Partial<Record<string, string>>
  /** 执行器的会话 id，按会话所属的节点记录。 */
  sessions: Partial<Record<string, string>>
  dialog?: DialogState
  pending?: Call
  question?: Question
  failure?: string
  /** 只追加的记录：每次调用、提问、回答和引擎说明。 */
  log: Entry[]
  nextCall: number
}

export type Event =
  | { kind: 'replied'; call: CallId; sessionId: string; text: string; usage: Usage; ms: number; model?: string }
  | { kind: 'call_failed'; call: CallId; error: string }
  | { kind: 'asked'; call: CallId; question: { id: string; text: string; options?: string[] } }
  | { kind: 'answered'; questionId: string; text: string }
  | { kind: 'retry' }
  | { kind: 'abort' }

export type Step = { task: Task; accepted: boolean; reason?: string }

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
})
export const isTerminal = (t: Task): boolean => t.status === 'done' || t.status === 'aborted'
