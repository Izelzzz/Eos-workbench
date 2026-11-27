// 工作流引擎：纯函数 reduce(task, event, at) → 新任务。不做 IO、不读时钟；at 由调用方给出。
import type { AgentNode, Check, DialogNode, GateNode, NodeId, RoleId, Workflow, WorkflowNode } from '../workflow/types.ts'
import { explain, failureFacts } from './failure.ts'
import { node as nodeOf, role as roleOf } from '../workflow/types.ts'
import { allPassed, describeCheck, describeFailures } from './checks.ts'
import {
  acceptPrompt,
  amendPrompt,
  approverOf,
  checksStuckQuestion,
  correctionStuckQuestion,
  correctPrompt,
  critiquePrompt,
  fixInstructPrompt,
  fixPrompt,
  gateStuckQuestion,
  instructPrompt,
  producePrompt,
  reapplyPrompt,
  reconfirmPrompt,
  respondPrompt,
  scopeNotice,
  stuckQuestion,
} from './prompts.ts'
import type { Call, CallId, CheckResult, CheckRun, ConventionDoc, CorrectionState, DialogState, Entry, Event, GateState, Question, ReviewKind, Step, Task } from './types.ts'
import { isCheck } from './types.ts'
import { describeVerdict, parseDecision, parseVerdict } from './verdict.ts'

/** 日志说明：对话打满轮次请上游重新确认、调用失败。证据归纳（evidence.ts）按这两种说明识别，改措辞时一起改。 */
export const escalationNote = (rounds: number, upstream: string): string => `${rounds} 轮未通过，请「${upstream}」重新确认`
export const CALL_FAILED_PREFIX = '调用失败：'
/** 越界撤销的说明以它开头（证据归纳用来跳过这条说明）。 */
export const REVERTED_NOTE_PREFIX = '撤销了 '

/** 卡点开始等验收人时的说明。耗时统计（metrics.ts）按 GATE_WAIT_MARK 认出人验收的等待从哪里开始。 */
export const GATE_WAIT_MARK = '次验收：等'
const gateWaitNote = (round: number, approver: string, target: string): string => `第 ${round} ${GATE_WAIT_MARK}${approver}验收「${target}」`

/** 回复格式不对时重新要求的次数；用完后任务失败，等人工重试。 */
export const MAX_FORMAT_RETRIES = 2

/** 新任务直接进入第一个节点：创建即发出第一项工作，不存在"已创建但没有事可做"的状态。 */
export const newTask = (p: { id: string; request: string; workflow: Workflow; docs: ConventionDoc[]; context?: string }, at: number): Task =>
  enter({ ...p, status: 'running', cursor: 0, outputs: {}, sessions: {}, scopeNotices: {}, fixes: 0, log: [], nextCall: 0 }, at)

const ok = (task: Task): Step => ({ task, accepted: true })
const ignore = (task: Task, reason: string): Step => ({ task, accepted: false, reason })
const append = (task: Task, entry: Entry): Task => ({ ...task, log: [...task.log, entry] })

const nextId = (task: Task): CallId => `c${task.nextCall + 1}` as CallId

/**
 * 发出一次调用。这个会话还有没通知出去的越界撤销时，说明加在提示词最前面，并在这里清除：
 * 通知只跟会话走，所以不管接下来是哪种用途的调用，发到这个会话的第一次调用一定带上它，而且只带一次。
 */
const issue = (task: Task, c: Omit<Call, 'id'>): Task => {
  const reverted = task.scopeNotices[c.session]
  const prompt = reverted === undefined ? c.prompt : scopeNotice(reverted, roleOf(task.workflow, c.role).writePaths) + c.prompt
  const { [c.session]: _cleared, ...scopeNotices } = task.scopeNotices
  return { ...task, status: 'running', pending: { ...c, id: nextId(task), prompt }, scopeNotices, nextCall: task.nextCall + 1 }
}

const runChecks = (task: Task, n: WorkflowNode): Task => ({
  ...task,
  status: 'running',
  pending: { id: nextId(task), node: n.id, purpose: 'check', checks: n.checks },
  nextCall: task.nextCall + 1,
})

const current = (task: Task): WorkflowNode | undefined => task.workflow.nodes[task.cursor]

const dialogNode = (task: Task): DialogNode => {
  const n = current(task)
  if (n?.kind !== 'dialog' || task.dialog?.node !== n.id) throw new Error(`任务 ${task.id} 不在对话节点上`)
  return n
}

const agentNode = (task: Task): AgentNode => {
  const n = current(task)
  if (n?.kind !== 'agent') throw new Error(`任务 ${task.id} 不在 agent 节点上`)
  return n
}

const gateNode = (task: Task): GateNode => {
  const n = current(task)
  if (n?.kind !== 'gate' || task.gate?.node !== n.id) throw new Error(`任务 ${task.id} 不在卡点上`)
  return n
}

const withDialog = (task: Task, patch: Partial<DialogState>): Task => ({ ...task, dialog: { ...task.dialog!, ...patch } })
const withGate = (task: Task, patch: Partial<GateState>): Task => ({ ...task, gate: { ...task.gate!, ...patch } })

/** 进入 cursor 指向的节点；走完所有节点就完成。 */
const enter = (task: Task, at: number): Task => {
  const n = current(task)
  if (n === undefined) return append({ ...task, status: 'done', pending: undefined, dialog: undefined, gate: undefined }, { type: 'note', at, text: '所有节点已完成' })
  if (n.kind === 'agent') return issue(task, { node: n.id, session: n.id, role: n.role, purpose: 'produce', prompt: producePrompt(task, n) })
  if (n.kind === 'gate') return decide({ ...task, gate: { node: n.id, round: 1, cycle: 1, phase: 'decide', fixes: 0, formatRetries: 0 } }, n, at)
  const opened: Task = { ...task, dialog: { node: n.id, round: 1, escalated: false, phase: 'check', formatRetries: 0, review: 'first' } }
  return beginRound(opened, n, 'first')
}

const advance = (task: Task, at: number): Task => enter({ ...task, cursor: task.cursor + 1, dialog: undefined, gate: undefined, fixes: 0 }, at)

/** 对话的一轮：先跑检查，检查通过（或没有检查）再请评审方。 */
const beginRound = (task: Task, d: DialogNode, review: ReviewKind): Task => {
  const t = withDialog(task, { review })
  return d.checks.length > 0 ? runChecks(withDialog(t, { phase: 'check' }), d) : critique(t, d, critiquePrompt(t, d, review))
}

/**
 * 一轮里检查（如果有）已通过：有评审方就请它评审，没有就算这一轮通过。
 * 评审方还没有会话时（例如第 1 轮检查没通过、开发改完后才第一次请它），给它完整的任务、需求和上游产出。
 */
const afterChecks = (task: Task, d: DialogNode, at: number): Task => {
  if (d.role === undefined) return passRound(task, d, at)
  const review = task.sessions[d.id] === undefined ? 'first' : task.dialog!.review
  return critique(task, d, critiquePrompt(task, d, review))
}

const passRound = (task: Task, d: DialogNode, at: number): Task => advance(append(task, { type: 'note', at, node: d.id, text: `第 ${task.dialog!.round} 轮通过` }), at)

/** agent 节点的产出（或补齐）之后：有检查就跑检查，没有就进入下一个节点。 */
const afterWork = (task: Task, n: AgentNode, at: number): Task => (n.checks.length > 0 ? runChecks(task, n) : advance(task, at))

const roleOfAgent = (task: Task, id: NodeId): RoleId => {
  const n = nodeOf(task.workflow, id)
  if (n.kind !== 'agent') throw new Error(`「${id}」不是 agent 节点`)
  return n.role
}

const critique = (task: Task, d: DialogNode, prompt: string): Task => {
  if (d.role === undefined) throw new Error(`对话「${d.id}」没有评审角色`)
  return issue(withDialog(task, { phase: 'critique' }), { node: d.id, session: d.id, role: d.role, purpose: 'critique', prompt })
}

const toTarget = (task: Task, d: DialogNode, purpose: 'respond' | 'reapply' | 'instruct', prompt: string): Task =>
  issue(withDialog(task, { phase: purpose }), { node: d.id, session: d.with, role: roleOfAgent(task, d.with), purpose, prompt })

const toUpstream = (task: Task, d: DialogNode, prompt: string): Task =>
  issue(withDialog(task, { phase: 'reconfirm' }), { node: d.id, session: d.escalate!, role: roleOfAgent(task, d.escalate!), purpose: 'reconfirm', prompt })

const ask = (task: Task, q: Omit<Question, 'id'>, at: number): Task => {
  const node = task.correction?.node ?? current(task)?.id
  const question: Question = { ...q, ...(node === undefined ? {} : { node }), id: `q${task.log.filter(e => e.type === 'question').length + 1}` }
  return append({ ...task, status: 'waiting_user', question, pending: q.source === 'loop' ? undefined : task.pending }, { type: 'question', at, question })
}

/** agent 节点的检查没通过：还有次数就让同一个 agent 补齐，用完了问用户。 */
const checksFailed = (task: Task, n: AgentNode, results: CheckResult[], at: number): Task => {
  if (task.fixes < n.maxFixes) {
    return issue({ ...task, fixes: task.fixes + 1 }, { node: n.id, session: n.id, role: n.role, purpose: 'fix', prompt: fixPrompt(task, n, results) })
  }
  return ask(task, { source: 'loop', text: checksStuckQuestion(n, results) }, at)
}

/**
 * 平台动作（推送等）失败而别的检查都通过了：agent 改不了（远程被别人改过、凭据不对……），不交回 agent。
 * 任务失败，等人处理后重试；重试时整轮检查重新跑一遍（挂上一次新的检查）。
 */
const platformFailed = (task: Task, n: WorkflowNode, results: CheckResult[], at: number): Task | undefined => {
  if (!results.every(r => r.passed || r.check.kind === 'platform')) return undefined
  const failed = results.filter(r => !r.passed)
  if (failed.length === 0) return undefined
  const failure = explain({
    where: `「${n.id}」的${failed.map(r => describeCheck(r.check)).join('、')}`,
    error: failed.map(r => r.detail).join('\n'),
    task: task.id,
    fix: '这是平台替任务做的动作，agent 改不了：按原因处理远程仓库或凭据',
  })
  return append({ ...runChecks(task, n), status: 'failed', failure }, { type: 'note', at, node: n.id, text: '平台动作没有完成，任务暂停，等人工处理后重试' })
}

/** 交回 agent 的失败说明：平台动作因为前面的检查没通过而跳过时，不算 agent 要处理的问题。 */
const agentFailures = (results: CheckResult[]): CheckResult[] => results.filter(r => r.check.kind !== 'platform')

/**
 * 卡点等验收人的结论。人验收：任务停下（waiting_accept），不挂任何工作，等命令行或网页上的结论；
 * 平台进程重启后状态原样从存储读回，不会重复发起。agent 验收：发一次 accept 调用，在卡点自己的会话里。
 */
const decide = (task: Task, g: GateNode, at: number): Task => {
  const t = withGate(task, { phase: 'decide', fixes: 0 })
  const noted = append(t, { type: 'note', at, node: g.id, text: gateWaitNote(t.gate!.round, approverOf(g), g.with) })
  if (g.by.kind === 'human') return { ...noted, status: 'waiting_accept', pending: undefined }
  return issue(noted, { node: g.id, session: g.id, role: g.by.role, purpose: 'accept', prompt: acceptPrompt(t, g, t.sessions[g.id] === undefined ? 'first' : 'again') })
}

const amend = (task: Task, g: GateNode, prompt: string): Task => issue(withGate(task, { phase: 'amend' }), { node: g.id, session: g.with, role: roleOfAgent(task, g.with), purpose: 'amend', prompt })

/**
 * 验收人给出了结论（人或 agent）。通过：往下走。打回：记下意见，交回被验收方原来的会话修改；
 * agent 验收这一段的打回次数用完了就问用户。round 在打回时加一：之后的修改、检查、提问都属于下一次验收，
 * 对上一次的结论（例如两个人同时看着同一次）因此作废。
 */
const onDecision = (task: Task, g: GateNode, d: { pass: boolean; comment: string; by: 'human' | RoleId }, at: number): Task => {
  const { round, cycle } = task.gate!
  const t = append(task, { type: 'decision', at, node: g.id, round, by: d.by, pass: d.pass, comment: d.comment })
  if (d.pass) return advance(append(t, { type: 'note', at, node: g.id, text: `第 ${round} 次验收通过` }), at)
  const rejected = withGate(t, { lastComment: d.comment, formatRetries: 0, round: round + 1 })
  if (g.by.kind === 'agent' && cycle >= g.by.maxRounds) return ask(withGate(rejected, { phase: 'ask' }), { source: 'loop', text: gateStuckQuestion(rejected, g, 'rounds') }, at)
  return amend(withGate(rejected, { cycle: cycle + 1 }), g, amendPrompt(rejected, g, { comment: d.comment, round }))
}

/** 被验收方改完：只重跑程序检查（不再请评审 agent），通过了（或没有检查）回到卡点。 */
const afterAmend = (task: Task, g: GateNode, at: number): Task => (g.checks.length > 0 ? runChecks(withGate(task, { phase: 'check' }), g) : decide(task, g, at))

/** 卡点上重跑的检查：通过回到卡点；没通过交回被验收方修，次数用完问用户。 */
const gateChecked = (task: Task, g: GateNode, results: CheckResult[], at: number): Task => {
  if (allPassed(results)) return decide(task, g, at)
  const failures = agentFailures(results)
  const t = withGate(task, { lastComment: describeFailures(failures) })
  if (t.gate!.fixes < g.maxFixes) return amend(withGate(t, { fixes: t.gate!.fixes + 1 }), g, amendPrompt(t, g, { failures }))
  return ask(withGate(t, { phase: 'ask' }), { source: 'loop', text: gateStuckQuestion(t, g, 'checks') }, at)
}

/**
 * 修正之后重跑的检查：工作流里所有节点的交付物和命令检查（不再请评审 agent），再加工作流里的平台动作
 * （推送到同一个分支、复用同一个 PR），排在最后：前面的检查都通过了才推送。同样的检查只跑一次。
 * 不只跑被修正节点自己的：修正可能改到别的节点负责的东西（例如改文档的节点也能改代码），推送前要和正常流程一样过一遍全部程序检查。
 */
export const correctionChecks = (wf: Workflow, _target: NodeId): Check[] => {
  const program = wf.nodes.flatMap(n => (n.kind === 'gate' ? [] : n.checks)).filter(c => c.kind !== 'platform')
  const platform = wf.nodes.flatMap(n => (n.kind === 'gate' ? [] : n.checks)).filter(c => c.kind === 'platform')
  const seen = new Set<string>()
  return [...program, ...platform].filter(c => {
    const k = JSON.stringify(c)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

const withCorrection = (task: Task, patch: Partial<CorrectionState>): Task => ({ ...task, correction: { ...task.correction!, ...patch } })

const correctionNode = (task: Task): AgentNode => {
  const n = nodeOf(task.workflow, task.correction!.node)
  if (n.kind !== 'agent') throw new Error(`修正交给的「${n.id}」不是 agent 节点`)
  return n
}

/** 修正交给节点原来的会话：用户的改正或补充、重跑检查的失败，或用户的指示。 */
const correctCall = (task: Task, prompt: string): Task => {
  const n = correctionNode(task)
  return issue(withCorrection(task, { phase: 'work' }), { node: n.id, session: n.id, role: n.role, purpose: 'correct', prompt })
}

const finishCorrection = (task: Task, at: number): Task =>
  append({ ...task, status: 'done', pending: undefined, correction: undefined }, { type: 'note', at, node: task.correction!.node, text: `第 ${task.correction!.round} 次修正完成` })

/** 节点改完：有要重跑的检查就跑，没有就结束这次修正。 */
const afterCorrect = (task: Task, at: number): Task => {
  const checks = correctionChecks(task.workflow, task.correction!.node)
  if (checks.length === 0) return finishCorrection(task, at)
  return { ...withCorrection(task, { phase: 'check' }), status: 'running', pending: { id: nextId(task), node: task.correction!.node, purpose: 'check', checks }, nextCall: task.nextCall + 1 }
}

/**
 * 修正后重跑的检查。全部通过：这次修正结束，任务回到完成。只有平台动作（推送、开 PR）没完成：agent 改不了，任务失败等人处理，
 * 重试时整轮重跑。别的检查没过：交回节点修，次数用完问用户。
 */
const correctionChecked = (task: Task, results: CheckResult[], at: number): Task => {
  if (allPassed(results)) return finishCorrection(task, at)
  const n = correctionNode(task)
  const failed = results.filter(r => !r.passed)
  if (results.every(r => r.passed || r.check.kind === 'platform')) {
    const failure = explain({
      where: `第 ${task.correction!.round} 次修正的${failed.map(r => describeCheck(r.check)).join('、')}`,
      error: failed.map(r => r.detail).join('\n'),
      task: task.id,
      fix: '这是平台替任务做的动作，agent 改不了：按原因处理远程仓库或凭据',
    })
    const again = afterCorrect(task, at)
    return append({ ...again, status: 'failed', failure }, { type: 'note', at, node: n.id, text: '平台动作没有完成，任务暂停，等人工处理后重试' })
  }
  const failures = agentFailures(results)
  if (task.correction!.fixes < n.maxFixes) return correctCall(withCorrection(task, { fixes: task.correction!.fixes + 1 }), correctPrompt(task, n, { failures }))
  return ask(withCorrection(task, { phase: 'ask' }), { source: 'loop', text: correctionStuckQuestion(task, n, failures) }, at)
}

/** 用户在已完成的任务上提交一条改正或补充：记下来，交给那个 agent 节点原来的会话（不是重新跑一遍）。 */
const onCorrected = (task: Task, node: NodeId, text: string, at: number): Task => {
  const round = task.log.filter(e => e.type === 'correction').length + 1
  const opened = append({ ...task, status: 'running', failure: undefined, correction: { round, node, phase: 'work', fixes: 0 } }, { type: 'correction', at, round, node, text })
  return correctCall(opened, correctPrompt(opened, correctionNode(opened), { text, round }))
}

const onChecked = (task: Task, run: CheckRun, results: CheckResult[], at: number): Task => {
  if (task.correction !== undefined) return correctionChecked(task, results, at)
  const n = current(task)!
  if (n.kind === 'gate') return gateChecked(task, gateNode(task), results, at)
  const blocked = platformFailed(task, n, results, at)
  if (blocked !== undefined) return blocked
  const passed = allPassed(results)
  if (n.kind === 'agent') {
    if (passed) return advance(append(task, { type: 'note', at, node: n.id, text: '交付物检查通过' }), at)
    return checksFailed(task, n, agentFailures(results), at)
  }
  const d = dialogNode(task)
  if (passed) return afterChecks(task, d, at)
  return notPassed(task, d, describeFailures(agentFailures(results)), at)
}

/**
 * 回复格式不对：在同一会话里重新要求；次数用完则失败，pending 保留成一个新的要求，人工重试时直接接着跑。
 * 重试次数记在对话或卡点的状态里（只会有其中一个）。
 */
const reformat = (task: Task, d: DialogNode | GateNode, at: number, again: (t: Task) => Task): Task => {
  const retries = (task.gate ?? task.dialog)!.formatRetries
  const set = (formatRetries: number) => (task.gate === undefined ? withDialog(task, { formatRetries }) : withGate(task, { formatRetries }))
  const next = again(set(retries >= MAX_FORMAT_RETRIES ? 0 : retries + 1))
  if (retries < MAX_FORMAT_RETRIES) return next
  return append(
    {
      ...next,
      status: 'failed',
      failure: explain({
        where: `「${d.id}」的回复`,
        error: `连续 ${retries + 1} 次无法解析成要求的 JSON 格式`,
        task: task.id,
        fix: '模型偶尔会这样：直接重试；反复出现时在日志里看它的原始回复，必要时调整这个角色的提示词',
      }),
    },
    { type: 'note', at, node: d.id, text: '回复格式无法解析，任务暂停，等人工重试' },
  )
}

/** 一轮评审没过：还有轮次就交回被评审方；用完了先请上游重新确认（一次），再问用户。 */
const notPassed = (task: Task, d: DialogNode, critique: string, at: number): Task => {
  const t = withDialog(task, { lastCritique: critique })
  if (t.dialog!.round < d.maxRounds) return toTarget(t, d, 'respond', respondPrompt(t, d, critique))
  if (d.escalate !== undefined && !t.dialog!.escalated) {
    const up = withDialog(t, { escalated: true })
    return toUpstream(append(up, { type: 'note', at, node: d.id, text: escalationNote(d.maxRounds, d.escalate) }), d, reconfirmPrompt(up, d, { stuck: true }))
  }
  return ask(withDialog(t, { phase: 'ask' }), { source: 'loop', text: stuckQuestion(t, d) }, at)
}

/**
 * 这次调用有改动越界、已被平台撤销：记进日志，并记下要通知的会话（下一次发到这个会话的调用带上说明）。
 * 通知按 call.session 记，不按节点：同一个节点的会话会被别的节点的调用（例如对话里的回应）接着用。
 * 一个会话最多只有一条待通知的记录：要再收到一次回复，就得先往这个会话发一次调用，而那次调用会把它带走。
 */
const noteReverted = (task: Task, call: Call, reverted: string[], at: number): Task =>
  append(
    { ...task, scopeNotices: { ...task.scopeNotices, [call.session]: reverted } },
    { type: 'note', at, node: call.node, text: `${REVERTED_NOTE_PREFIX}${reverted.length} 处越界改动：${reverted.join('、')}` },
  )

const onReply = (task: Task, call: Call, text: string, at: number): Task => {
  switch (call.purpose) {
    case 'produce':
      return afterWork({ ...task, outputs: { ...task.outputs, [call.node]: text } }, agentNode(task), at)

    case 'fix': {
      const prev = task.outputs[call.node]
      return afterWork({ ...task, outputs: { ...task.outputs, [call.node]: prev === undefined ? text : `${prev}\n\n# 补齐说明\n\n${text}` } }, agentNode(task), at)
    }

    case 'critique': {
      const d = dialogNode(task)
      const v = parseVerdict(text)
      if (v === undefined) return reformat(task, d, at, t => critique(t, d, critiquePrompt(t, d, 'format')))
      const t = withDialog(task, { formatRetries: 0 })
      if (v.verdict === 'pass') return passRound(t, d, at)
      return notPassed(t, d, describeVerdict(v), at)
    }

    case 'respond': {
      const d = dialogNode(task)
      const t = withDialog({ ...task, outputs: { ...task.outputs, [d.with]: text } }, { round: task.dialog!.round + 1 })
      return beginRound(t, d, 'reply')
    }

    case 'reapply':
    case 'instruct': {
      const d = dialogNode(task)
      const t = withDialog({ ...task, outputs: { ...task.outputs, [d.with]: text } }, { round: 1 })
      return beginRound(t, d, call.purpose === 'reapply' ? 'revised' : 'reply')
    }

    case 'accept': {
      const g = gateNode(task)
      const v = parseVerdict(text)
      if (v === undefined) return reformat(task, g, at, t => issue(t, { node: g.id, session: g.id, role: call.role, purpose: 'accept', prompt: acceptPrompt(t, g, 'format') }))
      return onDecision(withGate(task, { formatRetries: 0 }), g, { pass: v.verdict === 'pass', comment: describeVerdict(v), by: call.role }, at)
    }

    case 'correct': {
      // 修正的回复接在原来的产出后面（和补齐一样），不覆盖：之后的修正和卡点还要看原来的说明。
      const prev = task.outputs[call.node]
      const output = `${prev === undefined ? '' : `${prev}\n\n`}# 第 ${task.correction!.round} 次修正\n\n${text}`
      return afterCorrect({ ...task, outputs: { ...task.outputs, [call.node]: output } }, at)
    }

    case 'amend': {
      const g = gateNode(task)
      return afterAmend({ ...task, outputs: { ...task.outputs, [g.with]: text } }, g, at)
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

/**
 * 流程卡住时用户的指示。agent 节点：交给同一个 agent 补齐，补齐次数重新计算。
 * 对话节点：有上游就交给上游修订方案，否则直接交给被评审方。
 */
const onLoopAnswer = (task: Task, text: string): Task => {
  if (task.correction !== undefined) return correctCall(withCorrection(task, { fixes: 0 }), correctPrompt(task, correctionNode(task), { instruction: text }))
  const n = current(task)
  if (n?.kind === 'agent') return issue({ ...task, fixes: 0 }, { node: n.id, session: n.id, role: n.role, purpose: 'fix', prompt: fixInstructPrompt(text) })
  if (n?.kind === 'gate') {
    const g = gateNode(task)
    return amend(withGate(task, { cycle: 1, fixes: 0 }), g, amendPrompt(task, g, { instruction: text }))
  }
  const d = dialogNode(task)
  return d.escalate !== undefined ? toUpstream(task, d, reconfirmPrompt(task, d, { instruction: text })) : toTarget(task, d, 'instruct', instructPrompt(text))
}

export const reduce = (task: Task, event: Event, at: number): Step => {
  if (task.status === 'aborted') return ignore(task, '任务已中止')
  // 已完成的任务只接受改正或补充。
  if (task.status === 'done' && event.kind !== 'corrected') return ignore(task, '任务已结束')
  const round = (task.gate ?? task.dialog ?? task.correction)?.round
  switch (event.kind) {
    case 'replied': {
      const call = task.pending
      if (call === undefined || isCheck(call) || call.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次调用的结果')
      const reverted = event.reverted ?? []
      const recorded = append(
        { ...task, pending: undefined, question: undefined, status: 'running', sessions: { ...task.sessions, [call.session]: event.sessionId } },
        {
          type: 'call',
          at,
          call: call.id,
          node: call.node,
          role: call.role,
          purpose: call.purpose,
          ...(round === undefined ? {} : { round }),
          prompt: call.prompt,
          reply: event.text,
          usage: event.usage,
          ms: event.ms,
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(reverted.length === 0 ? {} : { reverted }),
        },
      )
      return ok(onReply(reverted.length === 0 ? recorded : noteReverted(recorded, call, reverted, at), call, event.text, at))
    }

    case 'checked': {
      const run = task.pending
      if (run === undefined || !isCheck(run) || run.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次检查的结果')
      if (event.results.length !== run.checks.length) return ignore(task, `检查结果有 ${event.results.length} 条，应该是 ${run.checks.length} 条`)
      const recorded = append(
        { ...task, pending: undefined, status: 'running' },
        { type: 'check', at, call: run.id, node: run.node, ...(round === undefined ? {} : { round }), results: event.results, ms: event.ms },
      )
      return ok(onChecked(recorded, run, event.results, at))
    }

    case 'call_failed':
      if (task.pending?.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次调用')
      return ok(
        append({ ...task, status: 'failed', failure: event.error, question: undefined }, { type: 'note', at, node: task.pending.node, text: `${CALL_FAILED_PREFIX}${failureFacts(event.error)}` }),
      )

    case 'asked': {
      if (task.pending === undefined || isCheck(task.pending) || task.pending.id !== event.call) return ignore(task, '不是当前这次调用')
      const open = task.status === 'waiting_user' && task.question?.call === event.call ? task.question : undefined
      // 崩溃后重发这次调用：agent 问的还是同一个问题，就继续等原来的回答；问了别的，就换成新问题，旧问题作废。
      if (open !== undefined && open.text === event.question.text) return ignore(task, '同一个问题已经在等回答')
      if (open === undefined && task.status !== 'running') return ignore(task, '不是当前这次调用')
      return ok(ask(task, { source: 'agent', call: event.call, text: event.question.text, ...(event.question.options === undefined ? {} : { options: event.question.options }) }, at))
    }

    case 'answered': {
      const q = task.question
      if (task.status !== 'waiting_user' || q?.id !== event.questionId) return ignore(task, '没有待回答的这个问题')
      const text = event.text.trim()
      if (text === '') return ignore(task, '回答不能为空')
      const answered = append({ ...task, question: undefined, status: 'running' }, { type: 'answer', at, questionId: q.id, text })
      return ok(q.source === 'agent' ? answered : onLoopAnswer(answered, text))
    }

    case 'decided': {
      const g = task.gate
      if (task.status !== 'waiting_accept' || g === undefined || g.node !== event.gate || g.round !== event.round) return ignore(task, '这个卡点现在不在等这次验收（可能已经有人决定过）')
      const comment = event.comment.trim()
      if (!event.pass && comment === '') return ignore(task, '打回时要写明意见')
      return ok(onDecision({ ...task, status: 'running' }, gateNode(task), { pass: event.pass, comment, by: 'human' }, at))
    }

    case 'corrected': {
      if (task.status !== 'done') return ignore(task, '只有已完成的任务可以提交改正或补充')
      const n = task.workflow.nodes.find(x => x.id === event.node)
      if (n?.kind !== 'agent') return ignore(task, `「${event.node}」不是这个工作流里的 agent 节点，只能交给 agent 节点：${agentNodes(task.workflow).join('、')}`)
      const text = event.text.trim()
      if (text === '') return ignore(task, '改正或补充的内容不能为空')
      return ok(onCorrected(task, n.id, text, at))
    }

    case 'retry':
      if (task.status !== 'failed') return ignore(task, '只有失败的任务可以重试')
      return ok(append({ ...task, status: 'running', failure: undefined }, { type: 'note', at, text: '人工重试' }))

    case 'abort':
      return ok(append({ ...task, status: 'aborted', pending: undefined, question: undefined }, { type: 'note', at, text: '已中止' }))
  }
}

/** 能接修正的节点：工作流里的 agent 节点（有自己的会话）。 */
export const agentNodes = (wf: Workflow): NodeId[] => wf.nodes.flatMap(n => (n.kind === 'agent' ? [n.id] : []))

/** 一次调用发到了哪个会话：完成工作和评审在节点自己的会话里，回应和调整在被评审方的会话里，重新确认在上游的会话里。 */
export const sessionOf = (wf: Workflow, call: { node: string; purpose: Call['purpose'] }): string => {
  const n = wf.nodes.find(x => x.id === call.node)
  if (call.purpose === 'correct') return call.node
  if (n?.kind === 'gate') return call.purpose === 'amend' ? n.with : call.node
  if (n?.kind !== 'dialog' || call.purpose === 'produce' || call.purpose === 'fix' || call.purpose === 'critique') return call.node
  return call.purpose === 'reconfirm' ? (n.escalate ?? call.node) : n.with
}

/** 当前节点在流程中的位置说明，给命令行和日志用。 */
export const describePosition = (task: Task): string => {
  const c = task.correction
  if (c !== undefined) return `第 ${c.round} 次修正 · ${c.node} · ${{ work: '修改中', check: '重跑检查', ask: '等用户指示' }[c.phase]}`
  const n = current(task)
  if (n === undefined) {
    const corrections = task.log.filter(e => e.type === 'correction').length
    return corrections === 0 ? '已完成' : `已完成（修正过 ${corrections} 次）`
  }
  if (n.kind === 'gate' && task.gate !== undefined) {
    const g = task.gate
    const phase = { decide: `等待验收（${approverOf(n)}）`, amend: `「${n.with}」按意见修改`, check: '修改后重跑检查', ask: '等用户指示' }[g.phase]
    return `${n.id} 第 ${g.round} 次验收 · ${phase}`
  }
  if (task.dialog === undefined) return task.pending?.purpose === 'check' ? `${n.id} · 检查` : task.fixes > 0 ? `${n.id} · 补齐 ${task.fixes}/${(n as AgentNode).maxFixes}` : `${n.id}`
  const d = task.dialog
  return `${n.id} 第 ${d.round}/${(n as DialogNode).maxRounds} 轮 · ${d.phase}${d.escalated ? ' · 已重新确认' : ''}`
}
