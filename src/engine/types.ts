// 引擎的状态与事件。Task 是任务的唯一状态；pending 就是"下一项要执行的工作"（outbox）：
// 一次 agent 调用，或一组由平台执行的检查。runner 执行它，把结果作为事件交回 reduce。
import type { Check, NodeId, RoleId, Workflow } from '../workflow/types.ts'

declare const brand: unique symbol
export type CallId = string & { readonly [brand]: 'CallId' }

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * 调用的用途：
 * produce 一个 agent 节点完成工作；fix 交付物检查没通过，同一个 agent 补齐；critique 评审给结论；respond 被评审方回应意见；
 * reconfirm 上游重新确认做法与需求；reapply 被评审方按修订方案调整；instruct 被评审方按用户指示调整；
 * accept 卡点上由 agent 验收；amend 被验收方按打回意见（或重跑检查的失败、用户的指示）修改。
 */
export type Purpose = 'produce' | 'fix' | 'critique' | 'respond' | 'reconfirm' | 'reapply' | 'instruct' | 'accept' | 'amend'

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

/** 平台执行的检查，不是模型调用。和调用共用 outbox：同一时刻只有一项待执行的工作。 */
export type CheckRun = {
  id: CallId
  node: NodeId
  purpose: 'check'
  checks: Check[]
}

export type Work = Call | CheckRun

export const isCheck = (w: Work): w is CheckRun => w.purpose === 'check'

/** detail：没通过时是原因（缺哪些章节、命令输出的最后一段）；通过时可以为空。 */
/** links：检查产出的链接（例如推上去的分支、开出的 PR），显示在任务页上。 */
export type CheckLink = { label: string; url: string; kind?: 'branch' | 'pull-request' }
export type CheckResult = { check: Check; passed: boolean; detail: string; links?: CheckLink[] }

/** 任务创建时从平台快照下来的团队约定文档；之后平台上改了也不影响这个任务。 */
export type ConventionDoc = { name: string; version: number; content: string }

/** 评审方接下来要看的是：第一次的产出、被评审方的回复，还是按新方案调整后的回复。 */
export type ReviewKind = 'first' | 'reply' | 'revised'

export type DialogPhase = 'check' | 'critique' | 'respond' | 'reconfirm' | 'reapply' | 'instruct' | 'ask'

export type DialogState = {
  node: NodeId
  /** 当前是第几轮评审，从 1 开始，不超过 maxRounds。 */
  round: number
  /** 是否已经自动请上游重新确认过（每个对话节点只自动一次，之后改为问用户）。 */
  escalated: boolean
  phase: DialogPhase
  /** 当前这一步的回复无法解析时已重新要求的次数。 */
  formatRetries: number
  /** 最近一次没通过的原因（检查结果或评审意见），交给被评审方或上游时引用。 */
  lastCritique?: string
  /** 这一轮检查通过后，评审方要看的内容。 */
  review: ReviewKind
}

/**
 * 卡点进行到哪一步：decide 等验收人的结论（人验收时任务是 waiting_accept，agent 验收时挂着一次 accept 调用）；
 * amend 被验收方在改；check 改完重跑程序检查；ask 自动处理用完了，等用户指示。
 */
export type GatePhase = 'decide' | 'amend' | 'check' | 'ask'

export type GateState = {
  node: NodeId
  /** 第几次验收，从 1 开始；用户给出指示后从 1 重新计。agent 验收时不超过它的 maxRounds。 */
  round: number
  phase: GatePhase
  /** 这一次打回之后，重跑检查不通过、自动交回修改的次数。 */
  fixes: number
  /** agent 验收的回复无法解析时已重新要求的次数。 */
  formatRetries: number
  /** 最近一次打回的意见或重跑检查的失败原因，问用户时引用。 */
  lastComment?: string
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

/** waiting_user：等用户回答问题；waiting_accept：停在卡点上等人验收。 */
export type TaskStatus = 'running' | 'waiting_user' | 'waiting_accept' | 'done' | 'failed' | 'aborted'

export type Entry =
  | {
      type: 'call'
      at: number
      call: CallId
      node: NodeId
      role: RoleId
      purpose: Purpose
      round?: number
      prompt: string
      reply: string
      usage: Usage
      ms: number
      model?: string
      /** 这次调用之后被平台撤销的越界改动（超出角色 writePaths 的路径），没有就不写。 */
      reverted?: string[]
    }
  | { type: 'check'; at: number; call: CallId; node: NodeId; round?: number; results: CheckResult[]; ms: number }
  | { type: 'question'; at: number; question: Question }
  | { type: 'answer'; at: number; questionId: string; text: string }
  | { type: 'note'; at: number; node?: NodeId; text: string }
  /** 卡点上的一次验收结论。by：human 是人，否则是验收的角色。打回时 comment 是意见，通过时可以为空。 */
  | { type: 'decision'; at: number; node: NodeId; round: number; by: 'human' | RoleId; pass: boolean; comment: string }

export type Task = {
  id: string
  request: string
  /** 平台提供的环境说明（工作目录、基线提交、查看改动的方法），放进每个节点的上下文。 */
  context?: string
  workflow: Workflow
  docs: ConventionDoc[]
  status: TaskStatus
  /** 正在进行的节点下标；等于节点数时任务完成。 */
  cursor: number
  /** 每个 agent 节点的最新产出。 */
  outputs: Partial<Record<string, string>>
  /** 执行器的会话 id，按会话所属的节点记录。 */
  sessions: Partial<Record<string, string>>
  /**
   * 还没通知出去的越界撤销（被撤销的路径），按会话记：下一次发到这个会话的调用在提示词最前面带上说明，发出后清除。
   * 一个会话同时最多一条：要再被撤销一次，就得先往这个会话发一次调用，而那次调用会把它带走。
   */
  scopeNotices: Partial<Record<string, string[]>>
  dialog?: DialogState
  /** 停在卡点上时的进度；和 dialog 不会同时存在。 */
  gate?: GateState
  /** 当前 agent 节点因检查没通过已自动补齐的次数，进入新节点时清零。 */
  fixes: number
  pending?: Work
  question?: Question
  failure?: string
  /** 只追加的记录：每次调用、提问、回答和引擎说明。 */
  log: Entry[]
  nextCall: number
}

export type Event =
  /** reverted：这次调用之后被平台撤销的越界改动，没有越界就不写或给空数组。 */
  | { kind: 'replied'; call: CallId; sessionId: string; text: string; usage: Usage; ms: number; model?: string; reverted?: string[] }
  | { kind: 'checked'; call: CallId; results: CheckResult[]; ms: number }
  | { kind: 'call_failed'; call: CallId; error: string }
  | { kind: 'asked'; call: CallId; question: { id: string; text: string; options?: string[] } }
  | { kind: 'answered'; questionId: string; text: string }
  /** 人在卡点上给出结论。gate、round 指明验收的是哪一次，过期的结论（已经有人决定过）被拒绝；打回时 comment 不能为空。 */
  | { kind: 'decided'; gate: NodeId; round: number; pass: boolean; comment: string }
  | { kind: 'retry' }
  | { kind: 'abort' }

export type Step = { task: Task; accepted: boolean; reason?: string }

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})
export const isTerminal = (t: Task): boolean => t.status === 'done' || t.status === 'aborted'
