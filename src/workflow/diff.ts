// 按行比较两个版本（最长公共子序列）。纯函数，页面、命令行和测试共用。
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** 太长的文本不做逐行比较（O(n·m)），整体显示为删掉旧的、加上新的。 */
const LIMIT = 3000

export const diffLines = (before: string, after: string): DiffLine[] => {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length > LIMIT || b.length > LIMIT) return [...a.map(text => ({ kind: 'del' as const, text })), ...b.map(text => ({ kind: 'add' as const, text }))]
  // lcs[i][j]：a[i..] 与 b[j..] 的最长公共子序列长度
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push({ kind: 'del', text: a[i++]! })
    else out.push({ kind: 'add', text: b[j++]! })
  }
  return out
}

/** 改动统计：加了几行、删了几行。 */
export const diffStat = (lines: DiffLine[]): { add: number; del: number } => ({ add: lines.filter(l => l.kind === 'add').length, del: lines.filter(l => l.kind === 'del').length })

export type FoldedLine = DiffLine | { kind: 'skip'; count: number }

/** 只保留改动前后各 context 行，其余连续未改动的行折叠成一行"省略 N 行"。 */
export const fold = (lines: DiffLine[], context = 3): FoldedLine[] => {
  const near = lines.map(() => false)
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) near[k] = true
  })
  const out: FoldedLine[] = []
  for (let i = 0; i < lines.length; i++) {
    if (near[i]) {
      out.push(lines[i]!)
      continue
    }
    const last = out.at(-1)
    if (last?.kind === 'skip') last.count++
    else out.push({ kind: 'skip', count: 1 })
  }
  return out
}
