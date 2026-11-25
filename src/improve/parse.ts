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

export type ParseResult = { ok: true; proposals: (ParsedProposal & { index: number })[]; refused: Refused[] } | { ok: false; error: string }

const FIELD: Record<string, string> = { target: '目标', 'target.kind': '目标种类', 'target.name': '目标名字', content: '新内容', rationale: '理由', evidence: '证据' }
/** zod 的出错位置 → 中文字段名：evidence.0 算作「证据」，空路径（整条不是对象）算作「提案」。 */
const fieldOf = (path: PropertyKey[]): string => FIELD[path.slice(0, 2).join('.')] ?? FIELD[String(path[0])] ?? '提案'

/** 从 start 处的 { 开始做括号匹配（跳过字符串里的内容），返回到配对的 } 为止的文本；不配对返回 undefined。 */
const balanced = (text: string, start: number): string | undefined => {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}

/**
 * 回复里的 {"proposals": …} 对象。不靠 ``` 代码块切分：新内容（技能、文档）里常有代码块，JSON 字符串里的反引号不转义，
 * 按代码块切会在内容中间截断。做法：从每个不在其他候选里面的 { 开始做括号匹配，留下能解析、带 proposals 数组的对象；
 * 优先取紧跟在 ```json 开头之后的（模型在正文里复述格式示例，例如「没有就给 {"proposals": []}」，不会顶替真正的答案），
 * 同样位置的取最后一个。一个都没有时退回通用的 extractJson。
 */
export const extractProposals = (text: string): unknown => {
  const found: { value: unknown; fenced: boolean }[] = []
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    const body = balanced(text, i)
    if (body === undefined) continue
    let value: unknown
    try {
      value = JSON.parse(body)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { proposals?: unknown }).proposals)) continue
    found.push({ value, fenced: /```json\s*$/.test(text.slice(0, i)) })
    i += body.length - 1 // 这个对象里面的 { 不再单独当作起点
  }
  const pick = found.filter(f => f.fenced).at(-1) ?? found.at(-1)
  return pick === undefined ? extractJson(text) : pick.value
}

/**
 * 解析回复并做和平台状态无关的核对：结构、目标在 targets 里、证据 id 都在 signals 里。
 * 和平台状态有关的核对（版本、内容能否保存、权限字段）、同一个约定只入库一条和条数上限由调用方再做：
 * 前一条被权限或保存校验拒绝时，同一个约定后面合格的那条仍然可以入库。
 */
export const parseProposals = (text: string, scope: { targets: { kind: TargetKind; name: string }[]; signals: Set<string> }): ParseResult => {
  const root = z.object({ proposals: z.array(z.unknown()) }).safeParse(extractProposals(text))
  if (!root.success) return { ok: false, error: '回复里没有 {"proposals": [...]} 格式的 JSON' }
  const proposals: (ParsedProposal & { index: number })[] = []
  const refused: Refused[] = []
  root.data.proposals.forEach((raw, index) => {
    const r = item.safeParse(raw)
    if (!r.success) {
      const errors = r.error.issues.map(i => `${fieldOf(i.path)}格式不对`)
      refused.push({ index, errors: [...new Set(errors)] })
      return
    }
    const p = r.data
    const target = { kind: p.target.kind, name: p.target.name }
    const errors: string[] = []
    if (!scope.targets.some(t => t.kind === target.kind && t.name === target.name)) errors.push('目标不在这次的范围里（只能改这些任务用到、并且有证据的约定）')
    const unknown = p.evidence.filter(id => !scope.signals.has(id))
    if (unknown.length > 0) errors.push(`引用了不存在的证据：${unknown.join('、')}`)
    if (errors.length > 0) refused.push({ index, target, errors })
    else proposals.push({ ...p, evidence: [...new Set(p.evidence)], index })
  })
  return { ok: true, proposals, refused }
}
