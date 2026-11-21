// 改进 agent 的回复是外部数据：只在这里解析成类型，并核对每条提案的目标和证据都在这次的范围里。纯函数。
import { z } from 'zod'
import { extractJson } from '../engine/verdict.ts'
import { TARGET_KINDS, type TargetKind } from '../engine/evidence.ts'

/** 一次生成最多入库几条提案（通过全部校验之后才算数，见 generate.ts）。 */
export const MAX_PROPOSALS = 3

const item = z.object({
  target: z.object({ kind: z.enum(TARGET_KINDS), name: z.string().trim().min(1) }),
  content: z.string().min(1),
  rationale: z.string().trim().min(1),
  evidence: z.array(z.string().trim().min(1)).min(1),
})

export type ParsedProposal = z.infer<typeof item>

/** 一条没被接受的提案：index 是它在回复里的下标，errors 是原因（中文）。 */
export type Refused = { index: number; target?: { kind: TargetKind; name: string }; errors: string[] }

export type ParseResult =
  | { ok: true; proposals: (ParsedProposal & { index: number })[]; refused: Refused[] }
  | { ok: false; error: string }

const FIELD: Record<string, string> = { target: '目标', 'target.kind': '目标种类', 'target.name': '目标名字', content: '新内容', rationale: '理由', evidence: '证据' }

/**
 * 解析回复并做和平台状态无关的核对：结构、目标在 targets 里、证据 id 都在 signals 里、同一个目标只能有一条。
 * 和平台状态有关的核对（版本、内容能否保存、权限字段）和条数上限由调用方再做。
 */
export const parseProposals = (text: string, scope: { targets: { kind: TargetKind; name: string }[]; signals: Set<string> }): ParseResult => {
  const root = z.object({ proposals: z.array(z.unknown()) }).safeParse(extractJson(text))
  if (!root.success) return { ok: false, error: '回复里没有 {"proposals": [...]} 格式的 JSON' }
  const proposals: (ParsedProposal & { index: number })[] = []
  const refused: Refused[] = []
  const seen = new Set<string>()
  root.data.proposals.forEach((raw, index) => {
    const r = item.safeParse(raw)
    if (!r.success) {
      const errors = r.error.issues.map(i => `${FIELD[i.path.join('.')] ?? i.path.join('.')}格式不对`)
      refused.push({ index, errors: [...new Set(errors)] })
      return
    }
    const p = r.data
    const target = { kind: p.target.kind, name: p.target.name }
    const key = `${target.kind}\u0000${target.name}`
    const errors: string[] = []
    if (!scope.targets.some(t => t.kind === target.kind && t.name === target.name)) errors.push('目标不在这次的范围里（只能改这些任务用到、并且有证据的约定）')
    const unknown = p.evidence.filter(id => !scope.signals.has(id))
    if (unknown.length > 0) errors.push(`引用了不存在的证据：${unknown.join('、')}`)
    if (seen.has(key)) errors.push('同一个约定只能有一条提案')
    if (errors.length > 0) refused.push({ index, target, errors })
    else {
      seen.add(key)
      proposals.push({ ...p, evidence: [...new Set(p.evidence)], index })
    }
  })
  return { ok: true, proposals, refused }
}
