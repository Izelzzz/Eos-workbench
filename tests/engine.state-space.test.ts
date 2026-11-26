// 对真实的 reduce 做广度优先穷举：每个可达状态都喂一遍所有类别的事件，检查每一步是否守住不变量。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_FORMAT_RETRIES, newTask, reduce } from '../src/engine/machine.ts'
import type { Event, Task } from '../src/engine/types.ts'
import { isCheck, zeroUsage } from '../src/engine/types.ts'
import type { AgentNode, DialogNode, GateNode, NodeId, Workflow } from '../src/workflow/types.ts'
import { ASK, CHANGES, GARBAGE, PASS, REVISE, results, workflow } from './helpers.ts'

/** 一次调用之后被平台撤销的越界路径（可写范围外的改动）。 */
const REVERTED = ['docs/design.md', 'top.txt']
/** 提示词里这段说明的标题，用来判断通知有没有发出去。 */
const NOTICE = '有改动被撤销（超出你的可写范围）'

const replies: Record<string, string[]> = {
  produce: ['产出'],
  fix: ['已补齐'],
  respond: ['已修改'],
  reapply: ['已按新方案修改'],
  instruct: ['已按指示修改'],
  critique: [PASS, CHANGES, GARBAGE],
  reconfirm: [REVISE, ASK, GARBAGE],
  accept: [PASS, CHANGES, GARBAGE],
  amend: ['已按验收意见修改'],
}

/** 当前状态下所有类别的事件，包括会被拒绝的（过期回复、空回答、非法重试）。 */
const eventsFor = (t: Task): Event[] => {
  const out: Event[] = [{ kind: 'retry' }, { kind: 'abort' }]
  out.push({ kind: 'replied', call: 'c0' as never, sessionId: 'stale', text: PASS, usage: zeroUsage(), ms: 1 })
  out.push({ kind: 'checked', call: 'c0' as never, results: [], ms: 1 })
  if (t.pending !== undefined && isCheck(t.pending)) {
    const run = t.pending
    out.push({ kind: 'checked', call: run.id, results: results(run, true), ms: 1 })
    out.push({ kind: 'checked', call: run.id, results: results(run, false), ms: 1 })
    if (run.checks.some(c => c.kind === 'platform')) out.push({ kind: 'checked', call: run.id, results: results(run, 'platform', '远程分支被别人改过'), ms: 1 })
    out.push({ kind: 'checked', call: run.id, results: [], ms: 1 })
    out.push({ kind: 'replied', call: run.id, sessionId: 'x', text: PASS, usage: zeroUsage(), ms: 1 })
    out.push({ kind: 'asked', call: run.id, question: { id: 'n', text: '检查不会提问' } })
    out.push({ kind: 'call_failed', call: run.id, error: '检查无法执行' })
  } else if (t.pending !== undefined) {
    const call = t.pending
    out.push({ kind: 'checked', call: call.id, results: [], ms: 1 })
    for (const text of replies[call.purpose]!) {
      out.push({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: zeroUsage(), ms: 1 })
      // 同一次回复的另一种结果：这次有改动越界、已被平台撤销。
      out.push({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: zeroUsage(), ms: 1, reverted: REVERTED })
      out.push({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: zeroUsage(), ms: 1, reverted: [] })
    }
    out.push({ kind: 'call_failed', call: call.id, error: 'boom' })
    out.push({ kind: 'asked', call: call.id, question: { id: 'n', text: '问一下' } })
    out.push({ kind: 'asked', call: call.id, question: { id: 'n2', text: '换个问题' } })
    out.push({ kind: 'call_failed', call: 'c0' as never, error: '过期的失败' })
    out.push({ kind: 'asked', call: 'c0' as never, question: { id: 'x', text: '过期的提问' } })
  }
  // 人在卡点上的结论：通过、带意见打回，以及会被拒绝的（空意见、过期的那一次、别的卡点）。不在等验收时也全部发一遍。
  const g = t.gate ?? { node: 'accept' as NodeId, round: 1 }
  out.push({ kind: 'decided', gate: g.node, round: g.round, pass: true, comment: '' })
  out.push({ kind: 'decided', gate: g.node, round: g.round, pass: false, comment: '缺少负数的测试' })
  out.push({ kind: 'decided', gate: g.node, round: g.round, pass: false, comment: '  ' })
  out.push({ kind: 'decided', gate: g.node, round: g.round + 1, pass: true, comment: '' })
  out.push({ kind: 'decided', gate: 'review' as never, round: g.round, pass: true, comment: '' })
  out.push({ kind: 'answered', questionId: 'q999', text: '回答一个不存在的问题' })
  if (t.question !== undefined) {
    out.push({ kind: 'answered', questionId: t.question.id, text: '用户的回答' })
    out.push({ kind: 'answered', questionId: t.question.id, text: ' ' })
  }
  return out
}

/** 抽象状态：去掉日志和文本，只保留决定后续行为的字段。 */
const key = (t: Task): string =>
  JSON.stringify({
    s: t.status,
    c: t.cursor,
    f: t.fixes,
    d: t.dialog && { ...t.dialog, lastCritique: undefined },
    // 第几次验收只增不减，只用来核对结论是不是过期的（事件按当前的 round 生成），不影响之后的行为，不算进状态，否则状态空间无穷。
    // 这一段的第几次（cycle）只在 agent 验收时和 maxRounds 比；人验收不限次数，也不算。
    g: t.gate && { ...t.gate, lastComment: undefined, round: undefined, cycle: gateOf(t.workflow, t.gate.node).by.kind === 'human' ? undefined : t.gate.cycle },
    p: t.pending && { u: t.pending.purpose, s: isCheck(t.pending) ? undefined : t.pending.session, n: t.pending.node },
    q: t.question?.source,
    sessions: Object.keys(t.sessions).sort(),
    // 有没有待通知的越界撤销会改变下一次调用的提示词，所以算不同的状态。
    notices: Object.keys(t.scopeNotices).sort(),
  })

const gateOf = (wf: Workflow, id: string): GateNode => wf.nodes.find(n => n.id === id) as GateNode
const gateWith = (wf: Workflow, id: string): string | undefined => {
  const n = wf.nodes.find(x => x.id === id)
  return n?.kind === 'gate' ? n.with : undefined
}

type Check = (before: Task, event: Event, after: Task, accepted: boolean, wf: Workflow) => string | undefined

const INVARIANTS: Record<string, Check> = {
  运行中必有待执行的调用: (_b, _e, a) => (a.status === 'running' && a.pending === undefined ? 'running without pending' : undefined),
  失败时保留可重试的调用: (_b, _e, a) => (a.status === 'failed' && a.pending === undefined ? 'failed without pending' : undefined),
  '等待用户时有问题；对话尽头的问题不占调用，agent 的问题挂在它的调用上': (_b, _e, a) => {
    if (a.status !== 'waiting_user') return a.question !== undefined && a.status !== 'running' && a.status !== 'failed' ? 'question outside waiting' : undefined
    if (a.question === undefined) return 'waiting without question'
    if (a.question.source === 'loop' && a.pending !== undefined) return 'loop question with pending'
    if (a.question.source === 'agent' && a.pending?.id !== a.question.call) return 'agent question not tied to pending'
    return undefined
  },
  结束后没有调用和问题: (_b, _e, a) => ((a.status === 'done' || a.status === 'aborted') && (a.pending ?? a.question) !== undefined ? 'leftover work' : undefined),
  轮次与格式重试在范围内: (_b, _e, a, _acc, wf) => {
    if (a.dialog === undefined) return undefined
    const d = wf.nodes.find(n => n.id === a.dialog!.node) as DialogNode
    if (a.dialog.round < 1 || a.dialog.round > d.maxRounds) return `round ${a.dialog.round}`
    return a.dialog.formatRetries > MAX_FORMAT_RETRIES ? 'format retries' : undefined
  },
  调用发到正确的会话: (_b, _e, a, _acc, wf) => {
    const p = a.pending
    if (p === undefined || isCheck(p)) return undefined
    const n = wf.nodes.find(x => x.id === p.node)!
    const expected =
      p.purpose === 'produce' || p.purpose === 'fix' || p.purpose === 'critique' || p.purpose === 'accept'
        ? p.node
        : p.purpose === 'amend'
          ? gateWith(wf, p.node)
          : p.purpose === 'reconfirm'
            ? (n as DialogNode).escalate
            : (n as DialogNode).with
    return p.session === expected ? undefined : `${p.purpose} sent to ${p.session}`
  },
  '调用 id 唯一且递增': (b, _e, a) => {
    if (a.pending === undefined || a.pending === b.pending) return undefined
    return a.pending.id === `c${a.nextCall}` && a.nextCall > b.nextCall ? undefined : `bad id ${a.pending.id}`
  },
  检查跑的是当前节点声明的检查: (_b, _e, a, _acc, wf) => {
    const p = a.pending
    if (p === undefined || !isCheck(p)) return undefined
    const n = wf.nodes[a.cursor]
    return n?.id === p.node && p.checks === n.checks && p.checks.length > 0 ? undefined : `check for ${p.node} at cursor ${a.cursor}`
  },
  '自动补齐不超过 maxFixes，且只在 agent 节点上': (_b, _e, a, _acc, wf) => {
    if (a.fixes === 0) return undefined
    const n = wf.nodes[a.cursor]
    return n?.kind === 'agent' && a.fixes <= n.maxFixes ? undefined : `fixes ${a.fixes} at ${n?.id}`
  },
  评审方只在本轮检查通过后才被请来: (b, e, a) => {
    if (a.pending?.purpose !== 'critique' || a.pending === b.pending || a.dialog?.phase !== 'critique') return undefined
    const n = a.workflow.nodes[a.cursor] as DialogNode
    if (n.checks.length === 0 || (e.kind === 'replied' && b.pending?.purpose === 'critique')) return undefined // 无检查，或格式不对重新要求
    return e.kind === 'checked' && e.results.every(r => r.passed) ? undefined : `critique after ${e.kind}`
  },
  '有评审方的对话只在评审给出 pass 时通过一轮': (b, e, a) => {
    const passedNow = a.log.slice(b.log.length).find(x => x.type === 'note' && x.text.endsWith('轮通过'))
    if (passedNow?.type !== 'note') return undefined
    const d = a.workflow.nodes.find(n => n.id === passedNow.node) as DialogNode
    if (d.role === undefined) return e.kind === 'checked' ? undefined : `check-only dialog passed by ${e.kind}`
    return e.kind === 'replied' && b.pending?.purpose === 'critique' ? undefined : `reviewed dialog passed by ${e.kind}`
  },
  '平台动作失败（别的检查都通过）不交回 agent：任务失败，挂着同一个节点的检查等重试': (b, e, a, accepted) => {
    if (!accepted || e.kind !== 'checked' || !e.results.some(r => r.check.kind === 'platform' && !r.passed)) return undefined
    const onlyPlatform = e.results.every(r => r.passed || r.check.kind === 'platform')
    if (!onlyPlatform) return a.pending !== undefined && !isCheck(a.pending) && a.pending.prompt.includes('前面的检查没有通过') ? 'skipped platform action shown to the agent' : undefined
    return a.status === 'failed' && a.pending !== undefined && isCheck(a.pending) && a.pending.node === b.pending?.node && a.pending.id !== b.pending.id
      ? undefined
      : `platform failure led to ${a.status} / ${a.pending?.purpose}`
  },
  每个对话节点只自动重新确认一次: (_b, _e, a) => {
    const autos = a.log.filter(e => e.type === 'note' && e.text.includes('重新确认') && e.text.includes('轮未通过')).length
    return autos > 1 ? `${autos} automatic escalations` : undefined
  },
  完成意味着走完所有节点且对话都通过: (_b, _e, a, _acc, wf) => {
    if (a.status !== 'done') return undefined
    if (a.cursor !== wf.nodes.length) return 'done before the last node'
    const passed = wf.nodes.filter(n => n.kind === 'dialog').every(n => a.log.some(e => e.type === 'note' && e.node === n.id && e.text.endsWith('轮通过')))
    if (!passed) return 'done without every dialog passing'
    const gates = wf.nodes.filter(n => n.kind === 'gate').every(n => a.log.some(e => e.type === 'decision' && e.node === n.id && e.pass))
    if (!gates) return 'done without every gate accepted'
    // 有交付物的 agent 节点：最后一次检查必须全部通过（之后不能再有它的产出或补齐）。
    const unchecked = wf.nodes
      .filter((n): n is AgentNode => n.kind === 'agent' && n.checks.length > 0)
      .find(n => {
        const last = a.log.findLast(e => (e.type === 'check' || e.type === 'call') && e.node === n.id)
        return last?.type !== 'check' || !last.results.every(r => r.passed)
      })
    return unchecked === undefined ? undefined : `done while ${unchecked.id} failed its checks`
  },
  '越界撤销只记在出事的那个会话上，而且不会丢': (b, e, a, accepted) => {
    if (!accepted || e.kind !== 'replied' || (e.reverted ?? []).length === 0) return undefined
    const call = b.pending
    if (call === undefined || isCheck(call)) return undefined
    const stored = a.scopeNotices[call.session]
    const next = a.pending !== undefined && !isCheck(a.pending) && a.pending !== b.pending ? a.pending : undefined
    const delivered = next?.session === call.session && next.prompt.includes(NOTICE)
    if (!delivered && !REVERTED.every(p => stored?.includes(p) === true)) return `notice for ${call.session} lost`
    const elsewhere = Object.keys(a.scopeNotices).filter(s => s !== call.session && b.scopeNotices[s] === undefined)
    return elsewhere.length === 0 ? undefined : `notice stored for ${elsewhere.join(',')}`
  },
  '待通知的越界撤销发给同一会话的下一次调用，发出后清除': (b, e, a, accepted) => {
    const p = a.pending
    if (!accepted || p === undefined || isCheck(p) || p === b.pending) return undefined
    // 这次回复自己带来的撤销也算待通知：记下来和发出去可能发生在同一步。
    const fresh = e.kind === 'replied' && (e.reverted ?? []).length > 0 && b.pending !== undefined && !isCheck(b.pending) && b.pending.session === p.session
    const waiting = b.scopeNotices[p.session] ?? (fresh ? (e as { reverted?: string[] }).reverted : undefined)
    if (waiting !== undefined) {
      if (!p.prompt.includes(NOTICE)) return `notice for ${p.session} not delivered`
      if (!waiting.every(path => p.prompt.includes(path))) return `notice for ${p.session} without its paths`
      if (a.scopeNotices[p.session] !== undefined) return `notice for ${p.session} not cleared`
    } else if (p.prompt.includes(NOTICE)) return `notice delivered to ${p.session} without one pending`
    const dropped = Object.keys(b.scopeNotices).filter(s => s !== p.session && a.scopeNotices[s] === undefined)
    return dropped.length === 0 ? undefined : `notice for ${dropped.join(',')} dropped`
  },
  对话和卡点不会同时进行: (_b, _e, a) => (a.dialog !== undefined && a.gate !== undefined ? 'dialog and gate at once' : undefined),
  '卡点状态只在卡点上，且属于当前节点': (_b, _e, a, _acc, wf) => {
    if (a.gate === undefined) return undefined
    const n = wf.nodes[a.cursor]
    return n?.kind === 'gate' && n.id === a.gate.node ? undefined : `gate ${a.gate.node} at cursor ${a.cursor}`
  },
  '等待验收：只在人验收的卡点上等结论，不挂调用、不挂问题': (_b, _e, a, _acc, wf) => {
    const waiting = a.status === 'waiting_accept'
    const shouldWait = a.gate?.phase === 'decide' && gateOf(wf, a.gate.node).by.kind === 'human' && a.status !== 'aborted' && a.status !== 'failed'
    if (waiting !== shouldWait) return `waiting_accept=${waiting} at phase ${a.gate?.phase}`
    return waiting && (a.pending ?? a.question) !== undefined ? 'waiting_accept with pending work or a question' : undefined
  },
  'agent 验收：等结论时挂着一次发到卡点自己会话的 accept 调用': (_b, _e, a, _acc, wf) => {
    if (a.gate?.phase !== 'decide' || gateOf(wf, a.gate.node).by.kind !== 'agent' || a.status === 'aborted') return undefined
    return a.pending?.purpose === 'accept' && !isCheck(a.pending) && a.pending.session === a.gate.node ? undefined : `agent gate deciding with ${a.pending?.purpose}`
  },
  '卡点的次数在范围内：第几次只增不减，agent 验收这一段的第几次不超过 maxRounds，重跑检查的补齐不超过 maxFixes': (b, _e, a, _acc, wf) => {
    if (a.gate === undefined) return undefined
    const g = gateOf(wf, a.gate.node)
    if (b.gate?.node === a.gate.node && a.gate.round < b.gate.round) return `gate round went back ${b.gate.round} → ${a.gate.round}`
    if (a.gate.round < 1 || a.gate.cycle < 1 || (g.by.kind === 'agent' && a.gate.cycle > g.by.maxRounds)) return `gate round ${a.gate.round} cycle ${a.gate.cycle}`
    if (a.gate.fixes > g.maxFixes) return `gate fixes ${a.gate.fixes}`
    return a.gate.formatRetries > MAX_FORMAT_RETRIES ? 'gate format retries' : undefined
  },
  '卡点只因验收人的通过结论放行：人的 decided 或 agent 的 pass': (b, e, a, accepted) => {
    const passed = a.log.slice(b.log.length).find(x => x.type === 'decision' && x.pass)
    if (passed === undefined) return undefined
    if (!accepted) return 'rejected event passed a gate'
    if (e.kind === 'decided' && e.pass) return undefined
    return e.kind === 'replied' && b.pending?.purpose === 'accept' && e.text === PASS ? undefined : `gate passed by ${e.kind}`
  },
  '打回修改之后，回到卡点之前只重跑程序检查，而且检查都通过': (b, e, a, _acc, wf) => {
    const back = a.log.slice(b.log.length).find(x => x.type === 'note' && x.text.includes('次验收：等'))
    if (back?.type !== 'note' || b.gate === undefined) return undefined
    const g = gateOf(wf, b.gate.node)
    if (g.checks.length === 0) return e.kind === 'replied' && b.pending?.purpose === 'amend' ? undefined : `back to gate without checks after ${e.kind}`
    return e.kind === 'checked' && b.gate.phase === 'check' && e.results.every(r => r.passed) ? undefined : `back to gate after ${e.kind} at ${b.gate.phase}`
  },
  '卡点打回之后不再请评审 agent': (_b, _e, a) => (a.pending?.purpose === 'critique' && a.log.some(x => x.type === 'decision' && !x.pass) ? 'critique after a gate send-back' : undefined),
  被拒绝的事件不改变任务: (b, _e, a, accepted) => (!accepted && a !== b ? 'rejected event changed the task' : undefined),
  日志只追加: (b, _e, a) => (a.log.length < b.log.length || b.log.some((e, i) => a.log[i] !== e) ? 'log rewritten' : undefined),
  空回答被拒绝: (_b, e, _a, accepted) => (e.kind === 'answered' && e.text.trim() === '' && accepted ? 'empty answer accepted' : undefined),
  '过期事件被拒绝：指向别的调用或不存在的问题': (b, e, _a, accepted) => {
    if (!accepted) return undefined
    if ((e.kind === 'replied' || e.kind === 'call_failed' || e.kind === 'asked' || e.kind === 'checked') && e.call !== b.pending?.id) return `stale ${e.kind} accepted`
    if ((e.kind === 'replied' || e.kind === 'asked') && b.pending !== undefined && isCheck(b.pending)) return `${e.kind} accepted for a check`
    if (e.kind === 'checked' && (b.pending === undefined || !isCheck(b.pending) || e.results.length !== b.pending.checks.length)) return 'checked accepted for a call or with wrong results'
    if (e.kind === 'answered' && e.questionId !== b.question?.id) return 'answer to another question accepted'
    if (e.kind === 'decided') {
      if (b.status !== 'waiting_accept' || b.gate?.node !== e.gate || b.gate.round !== e.round) return 'decision for another gate or round accepted'
      if (!e.pass && e.comment.trim() === '') return 'send-back without a comment accepted'
    }
    return undefined
  },
  失败状态只能通过重试或中止离开: (b, e, a, accepted) =>
    b.status === 'failed' && accepted && a.status !== 'failed' && e.kind !== 'retry' && e.kind !== 'abort' ? `failed left by ${e.kind}` : undefined,
  同一个问题不重复提出: (b, e, _a, accepted) => (e.kind === 'asked' && accepted && b.question?.call === e.call && b.question.text === e.question.text ? 'same question asked twice' : undefined),
}

const explore = (wf: Workflow, maxDepth: number) => {
  const start = newTask({ id: 't', request: '需求', workflow: wf, docs: [] }, 0)
  const seen = new Set([key(start)])
  let frontier = [start]
  let depth = 0
  let transitions = 0
  const violations: string[] = []
  const stuck: string[] = []
  // 一旦有不变量被破坏就停下：被改坏的引擎可能让状态空间不收敛，继续搜只会超时、掩盖真正的原因。
  while (frontier.length > 0 && depth < maxDepth && violations.length === 0) {
    const next: Task[] = []
    for (const t of frontier) {
      let movable = false
      for (const e of eventsFor(t)) {
        const step = reduce(t, e, depth + 1)
        transitions++
        for (const [name, check] of Object.entries(INVARIANTS)) {
          const why = check(t, e, step.task, step.accepted, wf)
          if (why !== undefined) violations.push(`${name}: ${why} (event ${e.kind}, state ${key(t)})`)
        }
        if (step.accepted && e.kind !== 'abort') movable = true
        const k = key(step.task)
        if (!seen.has(k)) {
          seen.add(k)
          next.push(step.task)
        }
      }
      if (!movable && t.status !== 'done' && t.status !== 'aborted') stuck.push(key(t))
    }
    frontier = next
    depth++
  }
  return { states: seen.size, transitions, depth, exhausted: frontier.length === 0, violations, stuck }
}

const CONFIGS = [
  { maxRounds: 2, escalate: true },
  { maxRounds: 1, escalate: true },
  { maxRounds: 2, escalate: false },
  { maxRounds: 2, escalate: true, checks: 'review' as const },
  { maxRounds: 2, escalate: false, checks: 'only' as const },
  { maxRounds: 1, escalate: true, checks: 'only' as const, maxFixes: 0 },
  { maxRounds: 1, escalate: false, checks: 'review' as const, maxFixes: 2 },
  { maxRounds: 1, escalate: false, checks: 'review' as const, ship: 1 },
  { maxRounds: 1, escalate: false, checks: 'review' as const, ship: 2 },
  { maxRounds: 1, escalate: false, gate: 'human' as const },
  { maxRounds: 1, escalate: false, checks: 'review' as const, gate: 'human' as const, gateFixes: 1, ship: 1 },
  { maxRounds: 1, escalate: true, gate: 'agent' as const, gateRounds: 2 },
  { maxRounds: 1, escalate: false, checks: 'only' as const, gate: 'agent' as const, gateRounds: 1, gateFixes: 0 },
]
const CHECKS = { none: '无检查', review: '有交付物、评审前跑测试', only: '有交付物、只有测试' }

for (const config of CONFIGS) {
  const result = explore(workflow(config), 200)
  test(`状态空间（maxRounds ${config.maxRounds}，${config.escalate ? '有' : '无'}上游，${CHECKS[config.checks ?? 'none']}${config.maxFixes === undefined ? '' : `，maxFixes ${config.maxFixes}`}${'gate' in config ? `，评审后${config.gate === 'human' ? '人' : ` agent（最多打回 ${config.gateRounds} 次）`}验收的卡点` : ''}${'ship' in config ? `，评审后交付（${config.ship} 轮）：测试通过再推送` : ''}）：${result.states} 个抽象状态、${result.transitions} 次转移全部守住不变量`, () => {
    assert.deepEqual(result.violations.slice(0, 5), [])
    assert.ok(result.exhausted, `still unexplored states at depth ${result.depth}`)
    assert.deepEqual(result.stuck.slice(0, 5), [], 'states where only abort moves the task')
  })
}

test('sessionOf agrees with the session every reachable pending call was sent to', async () => {
  const { sessionOf } = await import('../src/engine/machine.ts')
  for (const config of CONFIGS) {
    const wf = workflow(config)
    const seen = new Set<string>()
    let frontier = [newTask({ id: 't', request: 'r', workflow: wf, docs: [] }, 0)]
    // 和上面的穷举一样限制深度：被改坏的引擎状态空间可能不收敛。
    for (let depth = 0; frontier.length > 0; depth++) {
      assert.ok(depth < 200, 'state space did not converge')
      const next: Task[] = []
      for (const t of frontier) {
        if (t.pending !== undefined && !isCheck(t.pending)) assert.equal(sessionOf(wf, t.pending), t.pending.session, `${t.pending.purpose}@${t.pending.node}`)
        for (const e of eventsFor(t)) {
          const s = reduce(t, e, 1).task
          if (!seen.has(key(s))) {
            seen.add(key(s))
            next.push(s)
          }
        }
      }
      frontier = next
    }
  }
})
