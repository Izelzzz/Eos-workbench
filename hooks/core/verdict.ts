// 解析评审 agent 的结构化结论。解析不了一律按不通过处理：宁可多返工一次，也不放过。

export type Issue = { severity: 'blocker' | 'major' | 'minor'; file?: string; message: string }
export type Verdict = { verdict: 'pass' | 'fail'; summary: string; issues: Issue[] }

const candidates = (text: string): string[] => {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1] ?? '')
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  const bare = first >= 0 && last > first ? [text.slice(first, last + 1)] : []
  return [...fenced.reverse(), ...bare]
}

const asIssue = (raw: unknown): Issue | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const r = raw as Record<string, unknown>
  const message = typeof r.message === 'string' ? r.message : undefined
  if (message === undefined) return undefined
  const severity = r.severity === 'blocker' || r.severity === 'minor' ? r.severity : 'major'
  return typeof r.file === 'string' ? { severity, file: r.file, message } : { severity, message }
}

export const parseVerdict = (text: string): Verdict => {
  for (const candidate of candidates(text)) {
    try {
      const raw = JSON.parse(candidate) as Record<string, unknown>
      if (raw.verdict !== 'pass' && raw.verdict !== 'fail') continue
      const issues = Array.isArray(raw.issues)
        ? raw.issues.map(asIssue).filter((i): i is Issue => i !== undefined)
        : []
      // 有 blocker 的 pass 不算 pass。
      const verdict = raw.verdict === 'pass' && issues.some(i => i.severity === 'blocker') ? 'fail' : raw.verdict
      return { verdict, summary: typeof raw.summary === 'string' ? raw.summary : '', issues }
    } catch {
      continue
    }
  }
  return {
    verdict: 'fail',
    summary: '评审输出无法解析为约定的 JSON，按不通过处理',
    issues: [{ severity: 'major', message: text.slice(0, 2000) }],
  }
}

/** 把结论整理成给开发 agent 的反馈文字。 */
export const verdictFeedback = (v: Verdict): string =>
  [
    v.summary,
    ...v.issues.map(i => `- [${i.severity}]${i.file === undefined ? '' : ` ${i.file}`}: ${i.message}`),
  ]
    .filter(line => line !== '')
    .join('\n')
