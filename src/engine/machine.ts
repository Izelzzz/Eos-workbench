// 工作流引擎：纯函数 reduce(task, event, at) → 新任务。不做 IO、不读时钟；at 由调用方给出。
import type { DialogNode, Workflow, WorkflowNode } from '../workflow/types.ts'
import { node as nodeOf } from '../workflow/types.ts'
import {
  critiquePrompt, instructPrompt, producePrompt, reapplyPrompt, reconfirmPrompt, respondPrompt, stuckQuestion,
} from './prompts.ts'
import type { Call, CallId, DialogState, Entry, Event, Question, Step, Task } from './types.ts'
import { isTerminal } from './types.ts'
import { describeVerdict, parseDecision, parseVerdict } from './verdict.ts'

/** 回复格式不对时重新要求的次数；用完后任务失败，等人工重试。 */
export const MAX_FORMAT_RETRIES = 2

/** 新任务直接进入第一个节点：创建即发出第一个调用，不存在"已创建但没有事可做"的状态。 */
export const newTask = (p: { id: string; request: string; workflow: Workflow; context?: string }, at: number): Task =>
  enter({ ...p, status: 'running', cursor: 0, outputs: {}, sessions: {}, log: [], nextCall: 0 }, at)

const ok = (task: Task): Step => ({ task, accepted: true })
const ignore = (task: Task, reason: string): Step => ({ task, accepted: false, reason })
const append = (task: Task, entry: Entry): Task => ({ ...task, log: [...task.log, entry] })

const issue = (task: Task, c: Omit<Call, 'id'>): Task => ({
  ...task, status: 'running', pending: { ...c, id: `c${task.nextCall + 1}` as CallId }, nextCall: task.nextCall + 1,
})

const current = (task: Task): WorkflowNode | undefined => task.workflow.nodes[task.cursor]

const dialogNode = (task: Task): DialogNode => {
  const n = current(task)
  if (n?.kind !== 'dialog' || task.dialog?.node !== n.id) throw new Error(`任务 ${task.id} 不在对话节点上`)
  return n
}

const withDialog = (task: Task, patch: Partial<DialogState>): Task => ({ ...task, dialog: { ...task.dialog!, ...patch } })

/** 进入 cursor 指向的节点；走完所有节点就完成。 */
const enter = (task: Task, at: number): Task => {
  const n = current(task)
  if (n === undefined) return append({ ...task, status: 'done', pending: undefined, dialog: undefined }, { type: 'note', at, text: '所有节点已完成' })
  if (n.kind === 'agent') return issue(task, { node: n.id, session: n.id, role: n.role, purpose: 'produce', prompt: producePrompt(task, n) })
  const opened: Task = { ...task, dialog: { node: n.id, round: 1, escalated: false, phase: 'critique', formatRetries: 0 } }
  return critique(opened, n, critiquePrompt(opened, n, 'first'))
}

const advance = (task: Task, at: number): Task => enter({ ...task, cursor: task.cursor + 1, dialog: undefined }, at)

const critique = (task: Task, d: DialogNode, prompt: string): Task =>
  issue(withDialog(task, { phase: 'critique' }), { node: d.id, session: d.id, role: d.role, purpose: 'critique', prompt })

const toTarget = (task: Task, d: DialogNode, purpose: 'respond' | 'reapply' | 'instruct', prompt: string): Task =>
  issue(withDialog(task, { phase: purpose }), { node: d.id, session: d.with, role: nodeOf(task.workflow, d.with).role, purpose, prompt })

const toUpstream = (task: Task, d: DialogNode, prompt: string): Task =>
  issue(withDialog(task, { phase: 'reconfirm' }), { node: d.id, session: d.escalate!, role: nodeOf(task.workflow, d.escalate!).role, purpose: 'reconfirm', prompt })

const ask = (task: Task, q: Omit<Question, 'id'>, at: number): Task => {
  const question: Question = { ...q, id: `q${task.log.filter(e => e.type === 'question').length + 1}` }
  return append({ ...task, status: 'waiting_user', question, pending: q.source === 'loop' ? undefined : task.pending }, { type: 'question', at, question })
}

/** 回复格式不对：在同一会话里重新要求；次数用完则失败，pending 保留成一个新的要求，人工重试时直接接着跑。 */
const reformat = (task: Task, d: DialogNode, at: number, again: (t: Task) => Task): Task => {
  const retries = task.dialog!.formatRetries
  const next = again(withDialog(task, { formatRetries: retries >= MAX_FORMAT_RETRIES ? 0 : retries + 1 }))
  if (retries < MAX_FORMAT_RETRIES) return next
  return append({ ...next, status: 'failed', failure: `「${d.id}」的回复连续 ${retries + 1} 次无法解析` }, { type: 'note', at, node: d.id, text: '回复格式无法解析，任务暂停，等人工重试' })
}

/** 一轮评审没过：还有轮次就交回被评审方；用完了先请上游重新确认（一次），再问用户。 */
const notPassed = (task: Task, d: DialogNode, critique: string, at: number): Task => {
  const t = withDialog(task, { lastCritique: critique })
  if (t.dialog!.round < d.maxRounds) return toTarget(t, d, 'respond', respondPrompt(t, d, critique))
  if (d.escalate !== undefined && !t.dialog!.escalated) {
    const up = withDialog(t, { escalated: true })
    return toUpstream(append(up, { type: 'note', at, node: d.id, text: `${d.maxRounds} 轮未通过，请「${d.escalate}」重新确认` }), d, reconfirmPrompt(up, d, { stuck: true }))
  }
  return ask(withDialog(t, { phase: 'ask' }), { source: 'loop', text: stuckQuestion(t, d) }, at)
}

const onReply = (task: Task, call: Call, text: string, at: number): Task => {
  switch (call.purpose) {
    case 'produce':
      return advance({ ...task, outputs: { ...task.outputs, [call.node]: text } }, at)

    case 'critique': {
      const d = dialogNode(task)
      const v = parseVerdict(text)
      if (v === undefined) return reformat(task, d, at, t => critique(t, d, critiquePrompt(t, d, 'format')))
      const t = withDialog(task, { formatRetries: 0 })
      if (v.verdict === 'pass') return advance(append(t, { type: 'note', at, node: d.id, text: `第 ${t.dialog!.round} 轮通过` }), at)
      return notPassed(t, d, describeVerdict(v), at)
    }

    case 'respond': {
      const d = dialogNode(task)
      const t = withDialog({ ...task, outputs: { ...task.outputs, [d.with]: text } }, { round: task.dialog!.round + 1 })
      return critique(t, d, critiquePrompt(t, d, 'reply', text))
    }

    case 'reapply':
    case 'instruct': {
      const d = dialogNode(task)
      const t = withDialog({ ...task, outputs: { ...task.outputs, [d.with]: text } }, { round: 1 })
      return critique(t, d, critiquePrompt(t, d, call.purpose === 'reapply' ? 'revised' : 'reply', text))
    }

    case 'reconfirm': {
      const d = dialogNode(task)
      const decision = parseDecision(text)
      if (decision === undefined) return reformat(task, d, at, t => toUpstream(t, d, reconfirmPrompt(t, d, { format: true })))
      const t = withDialog(task, { formatRetries: 0 })
      if (decision.decision === 'ask_user') return ask(withDialog(t, { phase: 'ask' }), { source: 'loop', text: decision.question }, at)
      const revised = { ...t, outputs: { ...t.outputs, [d.escalate!]: decision.plan } }
      return toTarget(revised, d, 'reapply', reapplyPrompt(decision.plan))
    }
  }
}

/** 对话尽头的用户指示：有上游就交给上游修订方案，否则直接交给被评审方。 */
const onLoopAnswer = (task: Task, text: string): Task => {
  const d = dialogNode(task)
  return d.escalate !== undefined
    ? toUpstream(task, d, reconfirmPrompt(task, d, { instruction: text }))
    : toTarget(task, d, 'instruct', instructPrompt(text))
}

export const reduce = (task: Task, event: Event, at: number): Step => {
  if (isTerminal(task)) return ignore(task, '任务已结束')
  switch (event.kind) {
    case 'replied': {
      const call = task.pending
      if (call?.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次调用的结果')
      const recorded = append(
        { ...task, pending: undefined, question: undefined, status: 'running', sessions: { ...task.sessions, [call.session]: event.sessionId } },
        { type: 'call', at, call: call.id, node: call.node, role: call.role, purpose: call.purpose, ...(task.dialog === undefined ? {} : { round: task.dialog.round }),
          prompt: call.prompt, reply: event.text, usage: event.usage, ms: event.ms, ...(event.model === undefined ? {} : { model: event.model }) },
      )
      return ok(onReply(recorded, call, event.text, at))
    }

    case 'call_failed':
      if (task.pending?.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次调用')
      return ok(append({ ...task, status: 'failed', failure: event.error, question: undefined }, { type: 'note', at, node: task.pending.node, text: `调用失败：${event.error}` }))

    case 'asked':
      if (task.pending?.id !== event.call || task.status !== 'running') return ignore(task, '不是当前这次调用')
      return ok(ask(task, { source: 'agent', call: event.call, text: event.question.text, ...(event.question.options === undefined ? {} : { options: event.question.options }) }, at))

    case 'answered': {
      const q = task.question
      if (task.status !== 'waiting_user' || q?.id !== event.questionId) return ignore(task, '没有待回答的这个问题')
      const text = event.text.trim()
      if (text === '') return ignore(task, '回答不能为空')
      const answered = append({ ...task, question: undefined, status: 'running' }, { type: 'answer', at, questionId: q.id, text })
      return ok(q.source === 'agent' ? answered : onLoopAnswer(answered, text))
    }

    case 'retry':
      if (task.status !== 'failed') return ignore(task, '只有失败的任务可以重试')
      return ok(append({ ...task, status: 'running', failure: undefined }, { type: 'note', at, text: '人工重试' }))

    case 'abort':
      return ok(append({ ...task, status: 'aborted', pending: undefined, question: undefined }, { type: 'note', at, text: '已中止' }))
  }
}

/** 当前节点在流程中的位置说明，给命令行和日志用。 */
export const describePosition = (task: Task): string => {
  const n = current(task)
  if (n === undefined) return '已完成'
  if (task.dialog === undefined) return `${n.id}`
  const d = task.dialog
  return `${n.id} 第 ${d.round}/${(n as DialogNode).maxRounds} 轮 · ${d.phase}${d.escalated ? ' · 已重新确认' : ''}`
}

