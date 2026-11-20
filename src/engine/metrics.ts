// 按阶段（工作流节点）统计 token、工作时长和等待时长：执行成本和流程瓶颈可量化、可定位。纯函数，只读任务日志。
//
// 一个阶段从它的第一项活动开始，到最后一项活动结束（还在进行的阶段算到 now）。这段时间分成：
// - agent：模型调用的时长，减去调用中途等用户回答的时间；
// - 检查：平台执行交付物和命令检查的时长；
// - 等用户：从提问到回答（调用中途 agent 的提问，和流程卡住时的提问）；
// - 阻塞：从调用失败到人工重试（这段时间任务停着，等人处理）；
// - 平台开销：剩下的部分（进程启动、提交改动、排队等）。
// 各部分相加等于阶段时长（平台开销不会是负数：各部分有重叠时取 0，这种情况由测试覆盖）。
import type { Entry, Task, Usage } from './types.ts'
import { addUsage, zeroUsage } from './types.ts'

export type StageMetrics = {
  node: string
  calls: number
  checks: number
  usage: Usage
  agentMs: number
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

export type TaskMetrics = { stages: StageMetrics[]; total: Omit<StageMetrics, 'node' | 'open' | 'start' | 'end'> }

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

const overlap = (a: Span, b: Span): number => len({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) })

/** now：还在进行的等待（没回答的提问、没重试的失败）和阶段算到这个时刻。 */
export const taskMetrics = (task: Task, now: number): TaskMetrics => {
  const finished = task.status === 'done' || task.status === 'aborted'
  const lastAt = task.log.at(-1)?.at ?? now
  const until = finished ? lastAt : now
  const current = finished ? undefined : task.workflow.nodes[task.cursor]?.id

  // 提问的等待区间，按问题 id。
  const answers = new Map(task.log.flatMap(e => (e.type === 'answer' ? [[e.questionId, e.at] as const] : [])))
  const waits = task.log.flatMap(e => (e.type === 'question'
    ? [{ node: e.question.node as string | undefined, call: e.question.call as string | undefined, span: { start: e.at, end: answers.get(e.question.id) ?? until } }]
    : []))

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
    const start = activity.length === 0 ? undefined : Math.min(...activity.map(s => s.start))
    const end = open ? until : activity.length === 0 ? undefined : Math.max(...activity.map(s => s.end))
    const wallMs = start === undefined || end === undefined ? 0 : Math.max(0, end - start)
    // 调用中途的提问：等回答的时间不算 agent 工作时间。
    const callSpans = calls.map(c => ({ id: c.call as string, span: { start: c.at - c.ms, end: c.at } }))
    const agentMs = callSpans.reduce((sum, c) => sum + len(c.span) - nodeWaits.filter(w => w.call === c.id).reduce((s, w) => s + overlap(c.span, w.span), 0), 0)
    const checkMs = union(checks.map(c => ({ start: c.at - c.ms, end: c.at })))
    const waitUserMs = union(nodeWaits.map(w => w.span))
    const blockedMs = union(nodeBlocks.map(b => b.span))
    stages.push({
      node: n.id, calls: calls.length, checks: checks.length, usage: calls.reduce<Usage>((u, c) => addUsage(u, c.usage), zeroUsage()),
      agentMs, checkMs, waitUserMs, blockedMs, overheadMs: Math.max(0, wallMs - agentMs - checkMs - waitUserMs - blockedMs), wallMs,
      ...(start === undefined ? {} : { start }), ...(end === undefined ? {} : { end }), open,
    })
  }
  const sum = (k: 'calls' | 'checks' | 'agentMs' | 'checkMs' | 'waitUserMs' | 'blockedMs' | 'overheadMs' | 'wallMs') => stages.reduce((s, x) => s + x[k], 0)
  return {
    stages,
    total: {
      calls: sum('calls'), checks: sum('checks'), usage: stages.reduce<Usage>((u, s) => addUsage(u, s.usage), zeroUsage()),
      agentMs: sum('agentMs'), checkMs: sum('checkMs'), waitUserMs: sum('waitUserMs'), blockedMs: sum('blockedMs'), overheadMs: sum('overheadMs'), wallMs: sum('wallMs'),
    },
  }
}

const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`)
const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** 命令行用的阶段表。 */
export const formatMetrics = (m: TaskMetrics): string => {
  const head = ['阶段', '调用', '检查', '输入', '输出', '缓存读', 'agent', '检查耗时', '等用户', '阻塞', '平台开销', '总时长']
  const row = (name: string, x: TaskMetrics['total'], open = false) => [
    open ? `${name}（进行中）` : name, String(x.calls), String(x.checks), k(x.usage.input), k(x.usage.output), k(x.usage.cacheRead),
    secs(x.agentMs), secs(x.checkMs), secs(x.waitUserMs), secs(x.blockedMs), secs(x.overheadMs), secs(x.wallMs),
  ]
  const rows = [head, ...m.stages.map(s => row(s.node, s, s.open)), row('合计', m.total)]
  const widths = head.map((_, i) => Math.max(...rows.map(r => [...r[i]!].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0))))
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - [...s].reduce((x, ch) => x + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0)))
  return rows.map(r => r.map((c, i) => pad(c, widths[i]!)).join('  ').trimEnd()).join('\n')
}
