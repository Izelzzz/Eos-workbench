// 对真实的 reduce 做广度优先穷举：每个可达状态都喂一遍所有类别的事件，检查每一步是否守住不变量。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_FORMAT_RETRIES, newTask, reduce } from '../src/engine/machine.ts'
import type { Event, Task } from '../src/engine/types.ts'
import { isCheck, zeroUsage } from '../src/engine/types.ts'
import type { AgentNode, DialogNode, Workflow } from '../src/workflow/types.ts'
import { ASK, CHANGES, GARBAGE, PASS, REVISE, results, workflow } from './helpers.ts'

const replies: Record<string, string[]> = {
  produce: ['产出'], fix: ['已补齐'], respond: ['已修改'], reapply: ['已按新方案修改'], instruct: ['已按指示修改'],
  critique: [PASS, CHANGES, GARBAGE], reconfirm: [REVISE, ASK, GARBAGE],
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
    out.push({ kind: 'checked', call: run.id, results: [], ms: 1 })
    out.push({ kind: 'replied', call: run.id, sessionId: 'x', text: PASS, usage: zeroUsage(), ms: 1 })
    out.push({ kind: 'asked', call: run.id, question: { id: 'n', text: '检查不会提问' } })
    out.push({ kind: 'call_failed', call: run.id, error: '检查无法执行' })
  } else if (t.pending !== undefined) {
    const call = t.pending
    out.push({ kind: 'checked', call: call.id, results: [], ms: 1 })
    for (const text of replies[call.purpose]!) out.push({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: zeroUsage(), ms: 1 })
    out.push({ kind: 'call_failed', call: call.id, error: 'boom' })
    out.push({ kind: 'asked', call: call.id, question: { id: 'n', text: '问一下' } })
    out.push({ kind: 'asked', call: call.id, question: { id: 'n2', text: '换个问题' } })
    out.push({ kind: 'call_failed', call: 'c0' as never, error: '过期的失败' })
    out.push({ kind: 'asked', call: 'c0' as never, question: { id: 'x', text: '过期的提问' } })
  }
  out.push({ kind: 'answered', questionId: 'q999', text: '回答一个不存在的问题' })
  if (t.question !== undefined) {
    out.push({ kind: 'answered', questionId: t.question.id, text: '用户的回答' })
    out.push({ kind: 'answered', questionId: t.question.id, text: ' ' })
  }
  return out
}

/** 抽象状态：去掉日志和文本，只保留决定后续行为的字段。 */
const key = (t: Task): string => JSON.stringify({
  s: t.status, c: t.cursor, f: t.fixes, d: t.dialog && { ...t.dialog, lastCritique: undefined },
  p: t.pending && { u: t.pending.purpose, s: isCheck(t.pending) ? undefined : t.pending.session, n: t.pending.node }, q: t.question?.source,
  sessions: Object.keys(t.sessions).sort(),
})

type Check = (before: Task, event: Event, after: Task, accepted: boolean, wf: Workflow) => string | undefined

const INVARIANTS: Record<string, Check> = {
  '运行中必有待执行的调用': (_b, _e, a) => (a.status === 'running' && a.pending === undefined ? 'running without pending' : undefined),
  '失败时保留可重试的调用': (_b, _e, a) => (a.status === 'failed' && a.pending === undefined ? 'failed without pending' : undefined),
  '等待用户时有问题；对话尽头的问题不占调用，agent 的问题挂在它的调用上': (_b, _e, a) => {
    if (a.status !== 'waiting_user') return a.question !== undefined && a.status !== 'running' && a.status !== 'failed' ? 'question outside waiting' : undefined
    if (a.question === undefined) return 'waiting without question'
    if (a.question.source === 'loop' && a.pending !== undefined) return 'loop question with pending'
    if (a.question.source === 'agent' && a.pending?.id !== a.question.call) return 'agent question not tied to pending'
    return undefined
  },
  '结束后没有调用和问题': (_b, _e, a) => ((a.status === 'done' || a.status === 'aborted') && (a.pending ?? a.question) !== undefined ? 'leftover work' : undefined),
  '轮次与格式重试在范围内': (_b, _e, a, _acc, wf) => {
    if (a.dialog === undefined) return undefined
    const d = wf.nodes.find(n => n.id === a.dialog!.node) as DialogNode
    if (a.dialog.round < 1 || a.dialog.round > d.maxRounds) return `round ${a.dialog.round}`
    return a.dialog.formatRetries > MAX_FORMAT_RETRIES ? 'format retries' : undefined
  },
  '调用发到正确的会话': (_b, _e, a, _acc, wf) => {
    const p = a.pending
    if (p === undefined || isCheck(p)) return undefined
    const n = wf.nodes.find(x => x.id === p.node)!
    const expected = p.purpose === 'produce' || p.purpose === 'fix' || p.purpose === 'critique' ? p.node
      : p.purpose === 'reconfirm' ? (n as DialogNode).escalate : (n as DialogNode).with
    return p.session === expected ? undefined : `${p.purpose} sent to ${p.session}`
  },
  '调用 id 唯一且递增': (b, _e, a) => {
    if (a.pending === undefined || a.pending === b.pending) return undefined
    return a.pending.id === `c${a.nextCall}` && a.nextCall > b.nextCall ? undefined : `bad id ${a.pending.id}`
  },
  '检查跑的是当前节点声明的检查': (_b, _e, a, _acc, wf) => {
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
  '评审方只在本轮检查通过后才被请来': (b, e, a) => {
    if (a.pending?.purpose !== 'critique' || a.pending === b.pending || a.dialog?.phase !== 'critique') return undefined
    const n = a.workflow.nodes[a.cursor] as DialogNode
    if (n.checks.length === 0 || e.kind === 'replied' && b.pending?.purpose === 'critique') return undefined // 无检查，或格式不对重新要求
    return e.kind === 'checked' && e.results.every(r => r.passed) ? undefined : `critique after ${e.kind}`
  },
  '有评审方的对话只在评审给出 pass 时通过一轮': (b, e, a) => {
    const passedNow = a.log.slice(b.log.length).find(x => x.type === 'note' && x.text.endsWith('轮通过'))
    if (passedNow?.type !== 'note') return undefined
    const d = a.workflow.nodes.find(n => n.id === passedNow.node) as DialogNode
    if (d.role === undefined) return e.kind === 'checked' ? undefined : `check-only dialog passed by ${e.kind}`
    return e.kind === 'replied' && b.pending?.purpose === 'critique' ? undefined : `reviewed dialog passed by ${e.kind}`
  },
  '每个对话节点只自动重新确认一次': (_b, _e, a) => {
    const autos = a.log.filter(e => e.type === 'note' && e.text.includes('重新确认') && e.text.includes('轮未通过')).length
    return autos > 1 ? `${autos} automatic escalations` : undefined
  },
  '完成意味着走完所有节点且对话都通过': (_b, _e, a, _acc, wf) => {
    if (a.status !== 'done') return undefined
    if (a.cursor !== wf.nodes.length) return 'done before the last node'
    const passed = wf.nodes.filter(n => n.kind === 'dialog').every(n => a.log.some(e => e.type === 'note' && e.node === n.id && e.text.endsWith('轮通过')))
    if (!passed) return 'done without every dialog passing'
    // 有交付物的 agent 节点：最后一次检查必须全部通过（之后不能再有它的产出或补齐）。
    const unchecked = wf.nodes.filter((n): n is AgentNode => n.kind === 'agent' && n.checks.length > 0).find(n => {
      const last = a.log.findLast(e => (e.type === 'check' || e.type === 'call') && e.node === n.id)
      return last?.type !== 'check' || !last.results.every(r => r.passed)
    })
    return unchecked === undefined ? undefined : `done while ${unchecked.id} failed its checks`
  },
  '被拒绝的事件不改变任务': (b, _e, a, accepted) => (!accepted && a !== b ? 'rejected event changed the task' : undefined),
  '日志只追加': (b, _e, a) => (a.log.length < b.log.length || b.log.some((e, i) => a.log[i] !== e) ? 'log rewritten' : undefined),
  '空回答被拒绝': (_b, e, _a, accepted) => (e.kind === 'answered' && e.text.trim() === '' && accepted ? 'empty answer accepted' : undefined),
  '过期事件被拒绝：指向别的调用或不存在的问题': (b, e, _a, accepted) => {
    if (!accepted) return undefined
    if ((e.kind === 'replied' || e.kind === 'call_failed' || e.kind === 'asked' || e.kind === 'checked') && e.call !== b.pending?.id) return `stale ${e.kind} accepted`
    if ((e.kind === 'replied' || e.kind === 'asked') && b.pending !== undefined && isCheck(b.pending)) return `${e.kind} accepted for a check`
    if (e.kind === 'checked' && (b.pending === undefined || !isCheck(b.pending) || e.results.length !== b.pending.checks.length)) return 'checked accepted for a call or with wrong results'
    if (e.kind === 'answered' && e.questionId !== b.question?.id) return 'answer to another question accepted'
    return undefined
  },
  '失败状态只能通过重试或中止离开': (b, e, a, accepted) =>
    b.status === 'failed' && accepted && a.status !== 'failed' && e.kind !== 'retry' && e.kind !== 'abort' ? `failed left by ${e.kind}` : undefined,
  '同一个问题不重复提出': (b, e, _a, accepted) =>
    e.kind === 'asked' && accepted && b.question?.call === e.call && b.question.text === e.question.text ? 'same question asked twice' : undefined,
}

const explore = (wf: Workflow, maxDepth: number) => {
  const start = newTask({ id: 't', request: '需求', workflow: wf, docs: [] }, 0)
  const seen = new Set([key(start)])
  let frontier = [start]
  let depth = 0
  let transitions = 0
  const violations: string[] = []
  const stuck: string[] = []
  while (frontier.length > 0 && depth < maxDepth) {
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
  { maxRounds: 2, escalate: true }, { maxRounds: 1, escalate: true }, { maxRounds: 2, escalate: false },
  { maxRounds: 2, escalate: true, checks: 'review' as const }, { maxRounds: 2, escalate: false, checks: 'only' as const },
  { maxRounds: 1, escalate: true, checks: 'only' as const, maxFixes: 0 }, { maxRounds: 1, escalate: false, checks: 'review' as const, maxFixes: 2 },
]
const CHECKS = { none: '无检查', review: '有交付物、评审前跑测试', only: '有交付物、只有测试' }

for (const config of CONFIGS) {
  const result = explore(workflow(config), 200)
  test(`状态空间（maxRounds ${config.maxRounds}，${config.escalate ? '有' : '无'}上游，${CHECKS[config.checks ?? 'none']}${config.maxFixes === undefined ? '' : `，maxFixes ${config.maxFixes}`}）：${result.states} 个抽象状态、${result.transitions} 次转移全部守住不变量`, () => {
    assert.ok(result.exhausted, `still unexplored states at depth ${result.depth}`)
    assert.deepEqual(result.violations.slice(0, 5), [])
    assert.deepEqual(result.stuck.slice(0, 5), [], 'states where only abort moves the task')
  })
}

test('sessionOf agrees with the session every reachable pending call was sent to', async () => {
  const { sessionOf } = await import('../src/engine/machine.ts')
  for (const config of CONFIGS) {
    const wf = workflow(config)
    const seen = new Set<string>()
    let frontier = [newTask({ id: 't', request: 'r', workflow: wf, docs: [] }, 0)]
    while (frontier.length > 0) {
      const next: Task[] = []
      for (const t of frontier) {
        if (t.pending !== undefined && !isCheck(t.pending)) assert.equal(sessionOf(wf, t.pending), t.pending.session, `${t.pending.purpose}@${t.pending.node}`)
        for (const e of eventsFor(t)) {
          const s = reduce(t, e, 1).task
          if (!seen.has(key(s))) { seen.add(key(s)); next.push(s) }
        }
      }
      frontier = next
    }
  }
})
