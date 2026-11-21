// 生成改进提案（手动触发）：归纳证据 → 交给内置的 improver 模板 → 在边界解析回复 → 校验后入库为待审批的提案。
// improver 只从模板里取模型、effort 和提示词；权限由平台定死：只读、去掉全部工具组、不挂技能和 MCP，
// 工作目录是平台数据目录里的一个空目录（团队改了模板也放不开，见 ADR-004）。
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Conventions } from '../conventions/conventions.ts'
import { evidence } from '../engine/evidence.ts'
import { insights, sampleAt } from '../engine/insights.ts'
import { taskMetrics } from '../engine/metrics.ts'
import type { Usage } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import type { ProposalRow } from '../store/types.ts'
import { TOOL_GROUPS } from '../workflow/types.ts'
import { permissionChanges } from './guard.ts'
import { MAX_PROPOSALS, parseProposals, type Refused } from './parse.ts'
import { improvePrompt, selectScope, TARGET_NAMES, type Candidate } from './prompt.ts'
import { Proposals } from './proposals.ts'

export const IMPROVER = 'improver'

export type GenerateResult =
  | {
    ok: true
    run: string
    /** 没有证据时不调用模型。 */
    skipped?: string
    created: ProposalRow[]
    refused: Refused[]
    call?: { model?: string; usage: Usage; ms: number; reply: string }
  }
  /** run、call：调用过模型之后才失败（例如回复无法解析）时带上，用量和原始回复不丢。 */
  | { ok: false; error: string; run?: string; call?: { model?: string; usage: Usage; ms: number; reply: string } }

const PART_NAMES = { agentMs: 'agent', runningMs: '运行中', checkMs: '检查', waitUserMs: '等用户', blockedMs: '阻塞', overheadMs: '平台开销' } as const

export const generate = async (o: {
  store: Store
  conventions: Conventions
  executor: Executor
  dataDir: string
  workflow: string
  /** 只看这些任务；不给就是这个工作流所有已结束的任务。 */
  tasks?: string[]
  actor: string
  now: () => number
  log?: (line: string) => void
}): Promise<GenerateResult> => {
  const say = o.log ?? (() => {})
  const finished = (s: string) => s === 'done' || s === 'failed' || s === 'aborted'
  // 从早到晚：提示词里的任务按时间顺序，最后一个是最新的任务。
  const rows = o.store.list().filter(t => t.workflow === o.workflow && (o.tasks === undefined ? finished(t.status) : o.tasks.includes(t.id)))
    .sort((a, b) => a.createdAt - b.createdAt)
  const missing = (o.tasks ?? []).filter(id => !rows.some(r => r.id === id))
  if (missing.length > 0) return { ok: false, error: `这些任务不存在或不是工作流「${o.workflow}」的：${missing.join('、')}` }
  const running = rows.filter(r => !finished(r.status))
  if (running.length > 0) return { ok: false, error: `这些任务还没结束：${running.map(r => r.id).join('、')}` }
  if (rows.length === 0) return { ok: false, error: `工作流「${o.workflow}」还没有已结束的任务` }

  const samples = rows.map(r => ({ task: o.store.get(r.id)!, used: o.store.meta(r.id).conventions }))
  const run = `i${o.now().toString(36)}${randomBytes(3).toString('hex')}`
  const ev = evidence(samples)
  if (ev.signals.length === 0) return { ok: true, run, skipped: `${rows.length} 个任务里没有证据（评审都一次通过、检查都通过），不生成提案`, created: [], refused: [] }

  const scope = selectScope(ev)
  const candidates: Candidate[] = scope.targets.flatMap(t => {
    const row = o.store.convention(t.kind, t.name)
    return row === undefined ? [] : [{ ...t, version: row.version, content: row.content }]
  })
  const latest = samples.at(-1)!.task
  const roleTemplates = Object.fromEntries(Object.entries(latest.workflow.roles).flatMap(([id, r]) => (r.template === undefined ? [] : [[id, r.template.name]])))
  const b = insights(samples.map(s => ({ task: s.task, metrics: taskMetrics(s.task, sampleAt(s.task, o.now()), o.store.createdAt(s.task.id)) }))).bottlenecks[0]
  const bottleneck = b === undefined ? undefined : `「${b.node}」占所有阶段时长的 ${Math.round(b.share * 100)}%，其中 ${PART_NAMES[b.part]} 占比最大`
  const prompt = improvePrompt({ workflow: o.workflow, tasks: rows.map(r => r.id), signals: scope.signals, omitted: scope.omitted, candidates, roleTemplates, ...(bottleneck === undefined ? {} : { bottleneck }) })

  const t = o.conventions.lookup()(IMPROVER)
  if (t === undefined) return { ok: false, error: `平台上没有可用的 Agent 模板「${IMPROVER}」` }
  const cwd = join(o.dataDir, 'improve', run)
  mkdirSync(cwd, { recursive: true })
  say(`→ ${IMPROVER}：${rows.length} 个任务，${ev.signals.length} 条证据，${candidates.length} 个候选约定`)
  let reply
  try {
    reply = await o.executor.send({
      key: `improve/${run}`, nonce: `improve/${run}`, prompt: `${t.template.prompt.trimEnd()}\n\n${prompt}`,
      spec: {
        model: t.template.model, ...(t.template.effort === undefined ? {} : { effort: t.template.effort }), write: 'none', cwd,
        profile: { denyTools: [...TOOL_GROUPS], skills: [], mcp: [], background: false },
      },
      ask: async () => '不回答提问：请只根据消息里的证据和约定内容给出提案。',
    })
  } catch (e) {
    return { ok: false, error: `调用 ${IMPROVER} 失败：${(e as Error).message}` }
  } finally {
    await o.executor.release(cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
  say(`✓ ${IMPROVER}：${(reply.ms / 1000).toFixed(1)}s，输入 ${reply.usage.input}，输出 ${reply.usage.output}`)
  const call = { ...(reply.model === undefined ? {} : { model: reply.model }), usage: reply.usage, ms: reply.ms, reply: reply.text }

  const parsed = parseProposals(reply.text, { targets: candidates, signals: new Set(scope.signals.map(s => s.id)) })
  if (!parsed.ok) return { ok: false, error: `${IMPROVER} 的回复无法解析：${parsed.error}`, run, call }
  const proposals = new Proposals(o.store, o.conventions)
  const created: ProposalRow[] = []
  const refused: Refused[] = [...parsed.refused]
  for (const p of parsed.proposals) {
    if (created.length >= MAX_PROPOSALS) {
      refused.push({ index: p.index, target: p.target, errors: [`一次最多 ${MAX_PROPOSALS} 条提案`] })
      continue
    }
    const c = candidates.find(x => x.kind === p.target.kind && x.name === p.target.name)!
    const perms = permissionChanges(p.target.kind, c.content, p.content, o.conventions.lookup())
    if (perms.length > 0) {
      refused.push({ index: p.index, target: p.target, errors: perms })
      continue
    }
    const r = proposals.add({
      target: p.target, baseVersion: c.version, content: p.content, rationale: p.rationale, evidence: p.evidence,
      scope: { workflow: o.workflow, tasks: rows.map(x => x.id) },
      generator: { ...(reply.model === undefined ? {} : { model: reply.model }), usage: reply.usage, ms: reply.ms, run }, actor: o.actor,
    }, o.now())
    if (r.ok) created.push(r.row)
    else refused.push({ index: p.index, target: p.target, errors: r.errors })
  }
  for (const x of refused) say(`  没有入库：第 ${x.index + 1} 条${x.target === undefined ? '' : `（${TARGET_NAMES[x.target.kind]}「${x.target.name}」）`}：${x.errors.join('；')}`)
  return { ok: true, run, created, refused: refused.sort((a, b) => a.index - b.index), call }
}
