// 按阶段（工作流节点）统计 token、工作时长和等待时长：执行成本和流程瓶颈可量化、可定位。纯函数，只读任务日志。
//
// 一个阶段从它的第一项活动开始，到最后一项活动结束（还在进行的阶段算到 now）。这段时间分成：
// - agent：模型调用的时长，减去调用中途等用户回答的时间；
// - 运行中：正在跑、还没有结果的调用或检查，扣掉它中途等用户的时间（结束后归到 agent 或检查）；
// - 检查：平台执行交付物和命令检查的时长；
// - 等用户：从提问到回答（调用中途 agent 的提问，和流程卡住时的提问）；
// - 阻塞：从调用失败到人工重试（这段时间任务停着，等人处理）；
// - 平台开销：剩下的部分（进程启动、提交改动、排队等）。
// 各部分相加等于阶段时长（平台开销不会是负数：各部分有重叠时取 0）。
// 阶段之间的间隔（平台停着、重启续跑、被杀掉没记下来的调用）不属于任何阶段，单独算成 betweenMs。
// 已知偏差：崩溃后从 dsh 会话日志认领的回复，记录的时刻是认领时、耗时是原来那次运行的，调用区间会落在重启之后，
// 停机时间算进这个阶段的平台开销；调用失败前已经跑掉的时间没有记录，也算在平台开销里。
// 日志里没有「调用开始」的记录，运行中只能从上一条记录算起：进入新阶段时的平台时间（提交、启动 dsh）在阶段进行中时
// 算在运行中，阶段结束后变回阶段之间；runner 没在跑（崩溃、停着、回答后等人点「继续」）时运行中照样增长——
// 指标是纯函数，不知道 runner 在不在跑，由页面根据 runnerAlive 提示。
import type { Entry, Task, Usage } from './types.ts'
import { addUsage, zeroUsage } from './types.ts'

export type StageMetrics = {
  node: string
  calls: number
  checks: number
  usage: Usage
  agentMs: number
  /** 正在跑、还没有结果的调用或检查的时长（扣掉中途等用户），结束后归到 agent 或检查。 */
  runningMs: number
  checkMs: number
  waitUserMs: number
  blockedMs: number
  overheadMs: number
  wallMs: number
  start?: number
  end?: number
  /** 阶段还没结束（任务正停在这个阶段）。 */
  open: boolean
}

/** 按角色汇总的模型调用：用来跨任务比较 Agent 模板。 */
export type RoleMetrics = {
  role: string
  /** 角色来自哪个模板；直接写在工作流里的角色没有。 */
  template?: { name: string; version: number }
  calls: number
  usage: Usage
  agentMs: number
}

export type TaskMetrics = {
  stages: StageMetrics[]
  /** 按调用的角色汇总，按工作流里角色的顺序；没有调用的角色不列。 */
  roles: RoleMetrics[]
  total: Omit<StageMetrics, 'node' | 'open' | 'start' | 'end'>
  /** 从第一个阶段开始到最后一个阶段结束（或 now）。 */
  elapsedMs: number
  /** 不在任何阶段里的时间：阶段之间的间隔，例如平台停着、重启续跑、被杀掉没记下来的调用。 */
  betweenMs: number
}

/** 引擎写下的说明：调用失败、回复格式无法解析（任务停下）；人工重试（任务继续）。 */
const isFailure = (e: Entry): boolean => e.type === 'note' && (e.text.startsWith('调用失败：') || e.text.startsWith('回复格式无法解析'))
const isRetry = (e: Entry): boolean => e.type === 'note' && e.text === '人工重试'

type Span = { start: number; end: number }
const len = (s: Span) => Math.max(0, s.end - s.start)

/** 区间并集的总长度。 */
const union = (spans: Span[]): number => {
  const sorted = spans.filter(s => s.end > s.start).sort((a, b) => a.start - b.start)
  let total = 0
  let cur: Span | undefined
  for (const s of sorted) {
    if (cur === undefined || s.start > cur.end) {
      if (cur) total += len(cur)
      cur = { ...s }
    } else cur.end = Math.max(cur.end, s.end)
  }
  return total + (cur ? len(cur) : 0)
}

/** a 落在 b 里的部分。 */
const clip = (a: Span, b: Span): Span => ({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) })

/** now：进行中的部分算到这个时刻。createdAt：任务创建时刻（第一个阶段还没有任何记录时从这里算起）。 */
export const taskMetrics = (task: Task, now: number, createdAt?: number): TaskMetrics => {
  const finished = task.status === 'done' || task.status === 'aborted'
  const lastAt = task.log.at(-1)?.at ?? now
  const until = finished ? lastAt : now
  const current = finished ? undefined : task.workflow.nodes[task.cursor]?.id

  // 提问的等待区间：到下一条日志为止。等回答时只有这些事会写日志，而且都结束这次等待：回答、调用回复（问题作废）、
  // 调用失败、换成新问题（续跑后 agent 重新提问）、中止。还没有下一条日志的算到 until。
  const waits = task.log.flatMap((e, i) =>
    e.type === 'question' ? [{ node: e.question.node as string | undefined, call: e.question.call as string | undefined, span: { start: e.at, end: task.log[i + 1]?.at ?? until } }] : [],
  )

  // 失败到重试的阻塞区间：失败说明带着节点，重试说明不带，按顺序配对。
  const blocks: { node: string | undefined; span: Span }[] = []
  let failedAt: { node: string | undefined; at: number } | undefined
  for (const e of task.log) {
    if (isFailure(e) && e.type === 'note' && failedAt === undefined) failedAt = { node: e.node, at: e.at }
    else if (isRetry(e) && failedAt !== undefined) {
      blocks.push({ node: failedAt.node, span: { start: failedAt.at, end: e.at } })
      failedAt = undefined
    }
  }
  if (failedAt !== undefined) blocks.push({ node: failedAt.node, span: { start: failedAt.at, end: until } })

  const stages: StageMetrics[] = []
  const byRole = new Map<string, Omit<RoleMetrics, 'role' | 'template'>>()
  for (const n of task.workflow.nodes) {
    const calls = task.log.filter((e): e is Extract<Entry, { type: 'call' }> => e.type === 'call' && e.node === n.id)
    const checks = task.log.filter((e): e is Extract<Entry, { type: 'check' }> => e.type === 'check' && e.node === n.id)
    const nodeWaits = waits.filter(w => w.node === n.id)
    const nodeBlocks = blocks.filter(b => b.node === n.id)
    const activity: Span[] = [
      ...calls.map(c => ({ start: c.at - c.ms, end: c.at })),
      ...checks.map(c => ({ start: c.at - c.ms, end: c.at })),
      ...nodeWaits.map(w => w.span),
      ...nodeBlocks.map(b => b.span),
    ]
    const open = current === n.id
    if (activity.length === 0 && !open) continue
    // 进行中的阶段从上一个阶段结束时（第一个阶段从任务创建时）算起。
    const prevEnd = stages.at(-1)?.end ?? createdAt
    const starts = [...activity.map(s => s.start), ...(open && prevEnd !== undefined ? [prevEnd] : [])]
    const start = starts.length === 0 ? undefined : Math.min(...starts)
    const end = open ? until : activity.length === 0 ? undefined : Math.max(...activity.map(s => s.end))
    const wallMs = start === undefined || end === undefined ? 0 : Math.max(0, end - start)
    // 调用中途的提问：等回答的时间不算 agent 工作时间。
    const callSpans = calls.map(c => ({ id: c.call as string, span: { start: c.at - c.ms, end: c.at } }))
    const callAgent = callSpans.map(c => len(c.span) - union(nodeWaits.filter(w => w.call === c.id).map(w => clip(w.span, c.span))))
    const agentMs = callAgent.reduce((a, b) => a + b, 0)
    calls.forEach((c, i) => {
      const r = byRole.get(c.role) ?? { calls: 0, usage: zeroUsage(), agentMs: 0 }
      byRole.set(c.role, { calls: r.calls + 1, usage: addUsage(r.usage, c.usage), agentMs: r.agentMs + callAgent[i]! })
    })
    const checkMs = union(checks.map(c => ({ start: c.at - c.ms, end: c.at })))
    const waitUserMs = union(nodeWaits.map(w => w.span))
    const blockedMs = union(nodeBlocks.map(b => b.span))
    // 正在跑的调用或检查：从它之前最后一条与它无关的记录（它中途的提问和回答不算）到现在，扣掉中途等用户的时间。
    let runningMs = 0
    const p = task.pending
    if (open && p !== undefined && (task.status === 'running' || task.status === 'waiting_user' || task.status === 'waiting_accept') && start !== undefined && end !== undefined) {
      const own = new Set(task.log.flatMap(e => (e.type === 'question' && e.question.call === p.id ? [e.question.id] : [])))
      const before = task.log.findLast(e => !(e.type === 'question' && e.question.call === p.id) && !(e.type === 'answer' && own.has(e.questionId)))
      const span = { start: Math.max(start, before?.at ?? start), end }
      runningMs = Math.max(0, len(span) - union(nodeWaits.filter(w => w.call === p.id).map(w => clip(w.span, span))))
    }
    stages.push({
      node: n.id,
      calls: calls.length,
      checks: checks.length,
      usage: calls.reduce<Usage>((u, c) => addUsage(u, c.usage), zeroUsage()),
      agentMs,
      runningMs,
      checkMs,
      waitUserMs,
      blockedMs,
      overheadMs: Math.max(0, wallMs - agentMs - runningMs - checkMs - waitUserMs - blockedMs),
      wallMs,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      open,
    })
  }
  const starts = stages.flatMap(s => (s.start === undefined ? [] : [s.start]))
  const ends = stages.flatMap(s => (s.end === undefined ? [] : [s.end]))
  const elapsedMs = starts.length === 0 ? 0 : Math.max(0, Math.max(...ends) - Math.min(...starts))
  const sum = (k: 'calls' | 'checks' | 'agentMs' | 'runningMs' | 'checkMs' | 'waitUserMs' | 'blockedMs' | 'overheadMs' | 'wallMs') => stages.reduce((s, x) => s + x[k], 0)
  const wallMs = sum('wallMs')
  const roles = Object.keys(task.workflow.roles).flatMap(id => {
    const r = byRole.get(id)
    const template = task.workflow.roles[id]?.template
    return r === undefined ? [] : [{ role: id, ...(template === undefined ? {} : { template }), ...r }]
  })
  return {
    stages,
    roles,
    elapsedMs,
    betweenMs: Math.max(0, elapsedMs - wallMs),
    total: {
      calls: sum('calls'),
      checks: sum('checks'),
      usage: stages.reduce<Usage>((u, s) => addUsage(u, s.usage), zeroUsage()),
      agentMs: sum('agentMs'),
      runningMs: sum('runningMs'),
      checkMs: sum('checkMs'),
      waitUserMs: sum('waitUserMs'),
      blockedMs: sum('blockedMs'),
      overheadMs: sum('overheadMs'),
      wallMs,
    },
  }
}

export const secs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m${s % 60}s`
}
const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** 命令行用的阶段表。 */
export const formatMetrics = (m: TaskMetrics): string => {
  const head = ['阶段', '调用', '检查', '输入', '输出', '缓存读', 'agent', '运行中', '检查耗时', '等用户', '阻塞', '平台开销', '总时长']
  const row = (name: string, x: TaskMetrics['total'], open = false) => [
    open ? `${name}（进行中）` : name,
    String(x.calls),
    String(x.checks),
    k(x.usage.input),
    k(x.usage.output),
    k(x.usage.cacheRead),
    secs(x.agentMs),
    secs(x.runningMs),
    secs(x.checkMs),
    secs(x.waitUserMs),
    secs(x.blockedMs),
    secs(x.overheadMs),
    secs(x.wallMs),
  ]
  const rows = [head, ...m.stages.map(s => row(s.node, s, s.open)), row('合计', m.total)]
  const widths = head.map((_, i) => Math.max(...rows.map(r => [...r[i]!].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0))))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - [...s].reduce((x, ch) => x + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0)))
  const table = rows
    .map(r =>
      r
        .map((c, i) => pad(c, widths[i]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n')
  return `${table}\n任务总时长 ${secs(m.elapsedMs)}，其中不在任何阶段的 ${secs(m.betweenMs)}（阶段之间的间隔，例如平台停着或重启续跑）`
}
