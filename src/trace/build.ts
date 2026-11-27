// 把任务状态和 trace 事件整理成 Span 树：任务 → 节点 → 调用 → 模型步骤 → 工具。纯函数，Web 和测试共用。
import type { Entry, Purpose, Task, Usage } from '../engine/types.ts'
import { addUsage, isCheck, zeroUsage } from '../engine/types.ts'
import { describeCheck, describeRequirements } from '../engine/checks.ts'
import type { Span, SpanStatus, TraceEvent } from './types.ts'
import { roleOfNode } from '../workflow/types.ts'

export const PURPOSE: Record<Purpose, string> = {
  produce: '完成工作',
  fix: '补齐交付物',
  critique: '评审',
  respond: '回应评审',
  reconfirm: '重新确认',
  reapply: '按新方案调整',
  instruct: '按用户指示调整',
  accept: '验收',
  amend: '按验收意见修改',
  correct: '修正',
}

const ended = (spans: Span[]) => spans.every(s => s.end !== undefined)
const startOf = (spans: Span[]) => (spans.length === 0 ? undefined : Math.min(...spans.map(s => s.start)))
const endOf = (spans: Span[]) => (spans.length === 0 || !ended(spans) ? undefined : Math.max(...spans.map(s => s.end!)))
const sumUsage = (spans: Span[]) => spans.reduce<Usage>((u, s) => (s.usage === undefined ? u : addUsage(u, s.usage)), zeroUsage())
const byStart = (a: Span, b: Span) => a.start - b.start

const pretty = (args: string): string => {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

const instant = (id: string, kind: Span['kind'], name: string, at: number, extra: Partial<Span> = {}): Span => ({ id, kind, name, start: at, end: at, status: 'ok', meta: {}, children: [], ...extra })

/** 一次调用里的模型步骤与工具。open 为 true 表示调用还没结束，没收尾的步骤和工具显示为运行中。 */
const steps = (callId: string, events: TraceEvent[], prompt: string, open: boolean): Span[] => {
  const out: Span[] = []
  const tools = new Map<string, Span>()
  let current: Span | undefined
  let previousOutputs: string[] = []
  for (const e of events) {
    switch (e.kind) {
      case 'step_start':
        current = {
          id: `${callId}.s${out.length + 1}`,
          kind: 'model',
          name: `第 ${e.step} 步`,
          start: e.t,
          status: 'running',
          meta: {},
          children: [],
          input: out.length === 0 ? prompt : previousOutputs.join('\n\n────────\n\n'),
        }
        previousOutputs = []
        out.push(current)
        break
      case 'model':
        if (current === undefined) break
        Object.assign(current, { model: e.model, usage: e.usage, reasoning: e.reasoning, output: e.text })
        current.meta['模型耗时'] = `${((e.t - current.start) / 1000).toFixed(1)}s`
        if (e.toolCalls.length > 0) current.meta['请求工具'] = e.toolCalls.map(t => t.name).join('、')
        break
      case 'tool_start': {
        const tool: Span = { id: `${callId}.t.${e.id}`, kind: 'tool', name: e.name, start: e.t, status: 'running', input: pretty(e.args), meta: { 工具调用: e.id }, children: [] }
        tools.set(e.id, tool)
        ;(current ?? out.at(-1))?.children.push(tool)
        break
      }
      case 'tool_end': {
        const tool = tools.get(e.id)
        if (tool === undefined) break
        Object.assign(tool, { end: e.t, output: e.output, status: e.isError ? 'error' : 'ok' })
        previousOutputs.push(`【${tool.name}】\n${e.output}`)
        break
      }
      case 'step_end':
        if (current !== undefined) Object.assign(current, { end: e.t, status: 'ok' })
        current = undefined
        break
      case 'call_start':
        break
    }
  }
  if (!open) {
    // 调用已结束但日志缺了收尾事件（例如被杀的那次）：按最后一个时间点收尾，避免一直显示运行中。
    for (const s of out) if (s.end === undefined) Object.assign(s, { end: Math.max(s.start, ...s.children.map(c => c.end ?? c.start)), status: 'ok' })
  }
  return out
}

export const buildTrace = (task: Task, trace: { call: string; event: TraceEvent }[]): Span => {
  const eventsOf = new Map<string, TraceEvent[]>()
  for (const r of trace) eventsOf.set(r.call, [...(eventsOf.get(r.call) ?? []), r.event])
  const done = new Map(task.log.filter((e): e is Extract<Entry, { type: 'call' }> => e.type === 'call').map(e => [e.call as string, e]))

  /** 只有检查、没有评审方的对话里，被评审方回应的是检查失败，不是评审意见。 */
  const purposeLabel = (info: { node: string; purpose: Purpose }): string => {
    const n = task.workflow.nodes.find(x => x.id === info.node)
    return info.purpose === 'respond' && n?.kind === 'dialog' && n.role === undefined ? '处理检查失败' : PURPOSE[info.purpose]
  }

  const callSpan = (id: string): Span | undefined => {
    const entry = done.get(id)
    const pending = task.pending?.id === id && !isCheck(task.pending) ? task.pending : undefined
    const events = eventsOf.get(id) ?? []
    // 既不是已完成的调用、也不是当前的调用：中止时正在跑的那次。用 call_start 里记下的信息放回原处。
    const abandoned = entry === undefined && pending === undefined ? events.find(e => e.kind === 'call_start')?.call : undefined
    const info = entry ?? pending ?? abandoned
    if (info === undefined) return undefined
    const started = events.find(e => e.kind === 'call_start')?.t ?? (entry === undefined ? events[0]?.t : entry.at - entry.ms)
    const status: SpanStatus =
      entry !== undefined ? 'ok' : abandoned !== undefined ? 'error' : task.status === 'failed' ? 'error' : task.question?.call === id ? 'waiting' : task.status === 'running' ? 'running' : 'error'
    const children = steps(id, events, info.prompt, entry === undefined && status !== 'error')
    for (const e of task.log) {
      if (e.type === 'question' && e.question.call === id)
        children.push(
          instant(`${id}.${e.question.id}`, 'question', `提问 ${e.question.id}`, e.at, { output: e.question.text, meta: e.question.options ? { 选项: e.question.options.join(' / ') } : {} }),
        )
      if (e.type === 'answer' && task.log.some(q => q.type === 'question' && q.question.id === e.questionId && q.question.call === id)) {
        children.push(instant(`${id}.a.${e.questionId}`, 'answer', `回答 ${e.questionId}`, e.at, { output: e.text }))
      }
    }
    children.sort(byStart)
    const round = entry?.round ?? (pending !== undefined ? task.dialog?.round : undefined)
    const usage = entry?.usage ?? sumUsage(children)
    const model = entry?.model ?? children.find(c => c.model !== undefined)?.model
    return {
      id,
      kind: 'call',
      name: `${info.role} · ${purposeLabel(info)}${round === undefined ? '' : ` · 第 ${round} 轮`}${abandoned === undefined ? '' : '（已中止）'}`,
      start: started ?? entry?.at ?? 0,
      ...(entry === undefined ? {} : { end: entry.at }),
      status,
      usage,
      ...(model === undefined ? {} : { model }),
      input: info.prompt,
      ...(entry === undefined ? {} : { output: entry.reply }),
      meta: {
        调用: id,
        角色: info.role,
        用途: purposeLabel(info),
        ...(round === undefined ? {} : { 轮次: String(round) }),
        // 这次调用写到了可写范围外，平台在提交前撤销了这些路径。
        ...(entry?.reverted === undefined || entry.reverted.length === 0 ? {} : { 撤销的越界改动: entry.reverted.join('、') }),
        ...(task.status === 'failed' && pending !== undefined && task.failure !== undefined ? { 失败原因: task.failure } : {}),
        ...(abandoned === undefined ? {} : { 说明: '任务中止时这次调用还在进行；中止不会打断它，它之后的 trace 和用量仍记在这里' }),
      },
      children,
    }
  }

  const callIds = [...new Set([...done.keys(), ...(task.pending ? [task.pending.id as string] : []), ...eventsOf.keys()])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  const calls = callIds.map(callSpan).filter((s): s is Span => s !== undefined)
  const nodeOfCall = new Map(
    callIds.map(id => [id, (done.get(id) ?? (task.pending?.id === id ? task.pending : undefined) ?? eventsOf.get(id)?.find(e => e.kind === 'call_start')?.call)?.node as string | undefined]),
  )

  /** 平台检查：一次检查是一个 span，每一项检查是它的子 span，带没通过的原因。 */
  const checkSpans = (node: string): Span[] => {
    const spans: Span[] = task.log
      .filter((e): e is Extract<Entry, { type: 'check' }> => e.type === 'check' && e.node === node)
      .map(e => {
        const passed = e.results.filter(r => r.passed).length
        return {
          id: e.call,
          kind: 'check',
          name: `平台检查${e.round === undefined ? '' : ` · 第 ${e.round} 轮`} · ${passed === e.results.length ? '通过' : '没有通过'}`,
          start: e.at - e.ms,
          end: e.at,
          status: passed === e.results.length ? 'ok' : 'error',
          meta: { 检查: e.call, 结果: `${passed}/${e.results.length} 项通过`, 耗时: `${(e.ms / 1000).toFixed(1)}s`, ...(e.round === undefined ? {} : { 轮次: String(e.round) }) },
          children: e.results.map(
            (r, j) =>
              ({
                id: `${e.call}.r${j + 1}`,
                kind: 'check',
                name: describeCheck(r.check),
                start: e.at - e.ms,
                end: e.at,
                status: r.passed ? 'ok' : 'error',
                output: r.passed ? '通过' : r.detail,
                meta: { 结果: r.passed ? '通过' : '没有通过' },
                children: [],
              }) satisfies Span,
          ),
        } satisfies Span
      })
    const p = task.pending
    if (p !== undefined && isCheck(p) && p.node === node) {
      spans.push({
        id: p.id,
        kind: 'check',
        name: `平台检查${task.dialog === undefined ? '' : ` · 第 ${task.dialog.round} 轮`}`,
        start: task.log.at(-1)?.at ?? 0,
        status: task.status === 'failed' ? 'error' : 'running',
        input: describeRequirements(p.checks),
        meta: { 检查: p.id, ...(task.status === 'failed' && task.failure !== undefined ? { 失败原因: task.failure } : {}) },
        children: [],
      })
    }
    return spans
  }

  const nodes: Span[] = task.workflow.nodes.map((n, i) => {
    const children = [...calls.filter(c => nodeOfCall.get(c.id) === n.id), ...checkSpans(n.id)]
    const loopQuestions = new Set<string>()
    for (const [k, e] of task.log.entries()) {
      if (e.type === 'note' && e.node === n.id) children.push(instant(`${n.id}.note${k}`, 'note', e.text, e.at))
      if (e.type === 'correction' && e.node === n.id)
        children.push(instant(`${n.id}.correction${k}`, 'note', `第 ${e.round} 次修正：改正或补充（未经评审，改完只重跑程序检查）`, e.at, { output: e.text }))
      if (e.type === 'decision' && e.node === n.id)
        children.push(
          instant(`${n.id}.decision${k}`, 'note', `第 ${e.round} 次验收${e.pass ? '通过' : '打回'}（${e.by === 'human' ? '人' : e.by}）`, e.at, e.comment === '' ? {} : { output: e.comment }),
        )
      if (e.type === 'question' && e.question.source === 'loop' && e.question.node === n.id) {
        loopQuestions.add(e.question.id)
        children.push(instant(`${n.id}.${e.question.id}`, 'question', `提问 ${e.question.id}`, e.at, { output: e.question.text }))
      }
      if (e.type === 'answer' && loopQuestions.has(e.questionId)) children.push(instant(`${n.id}.a.${e.questionId}`, 'answer', `回答 ${e.questionId}`, e.at, { output: e.text }))
    }
    children.sort(byStart)
    // 正在修正的节点：按任务现在的状态显示（修正结束后任务回到完成）。
    const correcting = task.correction?.node === n.id
    const status: SpanStatus =
      i < task.cursor && !correcting
        ? 'ok'
        : i > task.cursor
          ? 'pending'
          : task.status === 'waiting_user' || task.status === 'waiting_accept'
            ? 'waiting'
            : task.status === 'failed'
              ? 'error'
              : task.status === 'aborted'
                ? 'error'
                : 'running'
    const start = startOf(children)
    const end = status === 'ok' ? endOf(children) : undefined
    return {
      id: n.id,
      kind: 'node',
      name: n.id,
      start: start ?? 0,
      ...(end === undefined ? {} : { end }),
      status,
      usage: sumUsage(children.filter(c => c.kind === 'call')),
      meta: {
        类型: n.kind === 'agent' ? 'agent 节点' : n.kind === 'dialog' ? '对话节点' : '卡点',
        ...(roleOfNode(n) === undefined ? {} : { 角色: roleOfNode(n)! }),
        ...(n.kind === 'gate' ? { 验收对象: n.with, 验收人: n.by.kind === 'human' ? '人' : `${n.by.role}（最多打回 ${n.by.maxRounds} 次）` } : {}),
        ...(n.kind === 'dialog' ? { 评审对象: n.with, 最多轮数: String(n.maxRounds), ...(n.escalate ? { 重新确认: n.escalate } : {}) } : {}),
        ...(n.checks.length === 0 ? {} : { 验收检查: describeRequirements(n.checks) }),
        ...(n.kind === 'agent' && n.checks.length > 0 ? { 最多自动补齐: `${n.maxFixes} 次` } : {}),
      },
      children,
    }
  })

  const reached = nodes.filter(n => n.status !== 'pending')
  const finished = task.status === 'done' || task.status === 'aborted'
  const lastNote = task.log.filter(e => e.type === 'note').at(-1)
  const taskStatus: SpanStatus = task.status === 'done' ? 'ok' : task.status === 'waiting_user' || task.status === 'waiting_accept' ? 'waiting' : task.status === 'running' ? 'running' : 'error'
  return {
    id: task.id,
    kind: 'task',
    name: task.request.split('\n')[0]!.slice(0, 80),
    start: startOf(reached) ?? 0,
    ...(finished && lastNote !== undefined ? { end: Math.max(lastNote.at, endOf(reached) ?? 0) } : {}),
    status: taskStatus,
    usage: sumUsage(nodes),
    input: task.request,
    meta: { 任务: task.id, 工作流: task.workflow.name, ...(task.failure ? { 失败原因: task.failure } : {}) },
    children: nodes,
  }
}

/** 树里所有 span 的时间范围，给瀑布图定比例尺。 */
export const bounds = (root: Span, now: number): { start: number; end: number } => {
  let start = Infinity
  let end = -Infinity
  const walk = (s: Span) => {
    if (s.start > 0) start = Math.min(start, s.start)
    end = Math.max(end, s.end ?? (s.start > 0 ? now : -Infinity))
    s.children.forEach(walk)
  }
  walk(root)
  return Number.isFinite(start) ? { start, end: Math.max(end, start + 1) } : { start: now, end: now + 1 }
}
