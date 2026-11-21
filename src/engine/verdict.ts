// 解析模型的结构化回复：评审结论与上游的重新确认。模型输出是外部数据，只在这里变成类型。
import { z } from 'zod'

const issue = z.object({
  severity: z.enum(['blocker', 'major', 'minor']).catch('major'),
  file: z.string().optional(),
  message: z.string().min(1),
})

const verdictSchema = z.object({
  verdict: z.enum(['pass', 'changes']),
  summary: z.string().default(''),
  issues: z.array(issue).default([]),
})

const decisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('revise'), plan: z.string().trim().min(1) }),
  z.object({ decision: z.literal('ask_user'), question: z.string().trim().min(1) }),
])

export type Verdict = z.infer<typeof verdictSchema>
export type Decision = z.infer<typeof decisionSchema>

/** 取最后一个 ```json 代码块；没有代码块时取第一个 { 到最后一个 } 之间的内容。 */
export const extractJson = (text: string): unknown => {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  const candidates = blocks.length > 0 ? blocks.map(b => b[1] ?? '').reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const c of candidates) {
    try {
      return JSON.parse(c)
    } catch {
      // 试下一个
    }
  }
  return undefined
}

export const parseVerdict = (text: string): Verdict | undefined => {
  const v = verdictSchema.safeParse(extractJson(text))
  if (!v.success) return undefined
  // 有 blocker 或 major 却写 pass，按 changes 处理：结论以问题清单为准。
  const serious = v.data.issues.some(i => i.severity !== 'minor')
  return serious && v.data.verdict === 'pass' ? { ...v.data, verdict: 'changes' } : v.data
}

export const parseDecision = (text: string): Decision | undefined => {
  const d = decisionSchema.safeParse(extractJson(text))
  return d.success ? d.data : undefined
}

export const describeVerdict = (v: Verdict): string =>
  [v.summary, ...v.issues.map((i, n) => `${n + 1}. [${i.severity}]${i.file === undefined ? '' : ` ${i.file}`}：${i.message}`)]
    .filter(s => s !== '')
    .join('\n')
