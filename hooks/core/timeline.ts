// /eos log 的时间线：events.jsonl 的每一行一条，加上每个阶段运行明细的汇总。纯函数。
import type { RunRecord, StageId, Task, Tokens } from '../../types'
import type { Actor, AuditEntry } from './audit'
import { TASK_LABEL, flowMetrics, formatDuration, formatTokens, inputTotal } from './metrics'
import { STAGES, addTokens, stageDef, zeroTokens } from './pipeline'

export const ACTOR_LABEL: Record<Actor, string> = {
  command: '命令',
  panel: '面板',
  agent: '子 agent',
  process: '进程',
  system: '系统',
}

const label = (id: StageId) => stageDef(id).label
const pad = (n: number) => String(n).padStart(2, '0')
const firstLine = (text: string | undefined, max = 80) => {
  const line = (text ?? '').split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  return line.length <= max ? line : `${line.slice(0, max)}…`
}

const usage = (durationMs: number, tokens: Tokens | undefined): string => {
  const t = tokens ?? zeroTokens()
  const parts = [formatDuration(durationMs)]
  if (inputTotal(t) > 0 || t.output > 0) parts.push(`${formatTokens(inputTotal(t))} 入 / ${formatTokens(t.output)} 出`)
  return parts.join(' · ')
}

const recordOf = (task: Task, stage: StageId, seq: number): RunRecord | undefined =>
  task.stages[stage].runs.find(r => r.seq === seq)

const describe = (e: AuditEntry, task: Task): string => {
  const ev = e.event
  const refused = e.action?.kind === 'none' && e.action.reason !== undefined ? e.action.reason : '没有变化'
  const abandoned = e.before?.stageStatus === 'running' && e.accepted
  switch (ev.kind) {
    case 'create':
      return `创建任务：${ev.title}`
    case 'agent': {
      const config = [
        ev.model,
        ev.effort === undefined ? undefined : `effort ${ev.effort}`,
        ev.skills === undefined ? undefined : `skill ${ev.skills.join('、')}`,
      ].filter((p): p is string => p !== undefined)
      const read = ev.readFirst === undefined ? '' : `；提示词里要求先读 ${ev.readFirst.length} 个 SKILL.md`
      return `${label(ev.stage)} 第 ${ev.seq} 次：启动子 agent${config.length === 0 ? '' : `（${config.join(' · ')}）`}${read}`
    }
    case 'approve':
      return e.accepted ? `人工批准 ${label(e.stage)}` : `批准未生效：${refused}`
    case 'reject':
      return e.accepted ? `驳回 ${label(e.stage)}：${ev.reason.trim()}` : `驳回未生效：${refused}`
    case 'skip':
      return e.accepted ? `跳过 ${label(e.stage)}：${ev.reason}` : `跳过未生效：${refused}`
    case 'retry':
      if (!e.accepted) return `重试未生效：${refused}`
      return abandoned ? `放弃 ${label(e.stage)} 第 ${e.before!.seq} 次（重试）` : `重试 ${label(e.stage)}`
    case 'abort':
      if (!e.accepted) return `中止未生效：${refused}`
      return abandoned ? `中止任务，放弃 ${label(e.stage)} 第 ${e.before!.seq} 次` : '中止任务'
    case 'progress':
    case 'finished': {
      const current = e.before?.seq === ev.seq && e.before.stageStatus === 'running'
      const name = `${label(ev.stage)} 第 ${ev.seq} 次`
      if (!current) {
        return e.accepted ? `${name}（已放弃）迟到的用量：${usage(ev.durationMs, ev.tokens)}，只记到这次运行上` : `${name}的过期结果，已忽略`
      }
      if (ev.kind === 'progress') return `${name}运行中：+${usage(ev.durationMs, ev.tokens)}`
      const record = recordOf(task, ev.stage, ev.seq)
      const total = record === undefined ? usage(ev.durationMs, ev.tokens) : usage(record.durationMs, record.tokens)
      const note = ev.ok ? '' : firstLine(ev.note)
      return `${name}运行结束：${ev.ok ? '通过' : '失败'} · ${total}${note === '' ? '' : `（${note}）`}`
    }
  }
}

/** 事件带来的下一步：开始哪个阶段的第几次、等待批准、完成或失败。 */
const consequence = (e: AuditEntry, task: Task): string => {
  const a = e.action
  switch (a?.kind) {
    case 'run': {
      const seq = a.stage === e.stage ? e.after.seq : task.stages[a.stage].runs.findLast(r => r.startedAt === e.ts)?.seq
      return ` → 开始 ${label(a.stage)}${seq === undefined ? '' : ` 第 ${seq} 次`}`
    }
    case 'wait':
      return ` → 等待批准 ${label(a.stage)}`
    case 'done':
      return ' → 流水线完成'
    case 'failed':
      return ` → 任务失败：${firstLine(a.reason)}`
    default:
      return ''
  }
}

const summary = (task: Task, now: number): string[] => {
  const lines = ['', '汇总']
  let abandonedMs = 0
  let abandonedTokens = zeroTokens()
  for (const s of STAGES) {
    const run = task.stages[s.id]
    const gone = run.runs.filter(r => r.outcome === 'abandoned')
    for (const r of gone) {
      abandonedMs += r.durationMs
      abandonedTokens = addTokens(abandonedTokens, r.tokens)
    }
    const head = `  ${s.label}`
    if (run.status === 'skipped' && run.runs.length === 0) {
      lines.push(`${head}  已跳过${run.note === undefined ? '' : `：${firstLine(run.note).replace(/^跳过：/, '')}`}`)
      continue
    }
    if (run.runs.length === 0 && run.attempts === 0) continue
    const counted =
      run.runs.length === 0
        ? `${run.attempts} 次（早于运行明细，只有累计值）`
        : `${run.runs.length - gone.length} 次${gone.length === 0 ? '' : `，放弃 ${gone.length} 次（${usage(gone.reduce((n, r) => n + r.durationMs, 0), gone.reduce((t, r) => addTokens(t, r.tokens), zeroTokens()))}）`}`
    lines.push(`${head}  ${counted} · ${usage(run.durationMs, run.tokens)}${run.waitMs > 0 ? ` · 等待 ${formatDuration(run.waitMs)}` : ''}`)
  }
  const m = flowMetrics(task, now)
  lines.push(
    `  合计  执行 ${formatDuration(m.processMs)} · 等待 ${formatDuration(m.waitMs)} · Token ${formatTokens(inputTotal(m.tokens))} 入 / ${formatTokens(m.tokens.output)} 出 · 返工 ${m.rework}`,
  )
  if (abandonedMs > 0 || inputTotal(abandonedTokens) > 0 || abandonedTokens.output > 0) {
    lines.push(`  被放弃的运行另外花了 ${usage(abandonedMs, abandonedTokens)}（不计入上面的合计）`)
  }
  return lines
}

/** offsetMinutes：本地时区相对 UTC 的分钟数（东八区是 480）。 */
export const formatTimeline = (p: {
  task: Task
  entries: AuditEntry[]
  now: number
  offsetMinutes: (ts: number) => number
}): string => {
  const { task, entries } = p
  const lines = [`「${task.title}」 ${task.id} · ${TASK_LABEL[task.status]}`]
  if (entries.length === 0) lines.push('', '（没有事件记录：这个任务创建于审计记录之前）')
  let day = ''
  for (const e of entries) {
    const local = new Date(e.ts + p.offsetMinutes(e.ts) * 60_000)
    const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`
    if (date !== day) {
      lines.push('', date)
      day = date
    }
    const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
    lines.push(`  ${time}  [${ACTOR_LABEL[e.actor]}] ${describe(e, task)}${consequence(e, task)}`)
  }
  return [...lines, ...summary(task, p.now)].join('\n')
}
