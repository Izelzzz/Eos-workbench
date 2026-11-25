// 从任务日志汇总耗时与 token：按节点、按角色。纯函数，CLI 和以后的 Web 共用。
import type { Task, Usage } from './types.ts'
import { addUsage, zeroUsage } from './types.ts'

export type Totals = { calls: number; ms: number; usage: Usage }

const empty = (): Totals => ({ calls: 0, ms: 0, usage: zeroUsage() })
const add = (t: Totals, ms: number, u: Usage): Totals => ({ calls: t.calls + 1, ms: t.ms + ms, usage: addUsage(t.usage, u) })

export type Report = { byNode: Record<string, Totals>; byRole: Record<string, Totals>; total: Totals }

export const report = (task: Task): Report => {
  const byNode: Record<string, Totals> = {}
  const byRole: Record<string, Totals> = {}
  let total = empty()
  for (const e of task.log) {
    if (e.type !== 'call') continue
    byNode[e.node] = add(byNode[e.node] ?? empty(), e.ms, e.usage)
    byRole[e.role] = add(byRole[e.role] ?? empty(), e.ms, e.usage)
    total = add(total, e.ms, e.usage)
  }
  return { byNode, byRole, total }
}

const n = (x: number) => x.toLocaleString('en-US')
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

export const formatTotals = (label: string, t: Totals): string =>
  `${label.padEnd(12)} ${String(t.calls).padStart(3)} 次  ${secs(t.ms).padStart(8)}  输入 ${n(t.usage.input).padStart(8)}  输出 ${n(t.usage.output).padStart(7)}  缓存读 ${n(t.usage.cacheRead).padStart(9)}  缓存写 ${n(t.usage.cacheWrite).padStart(6)}`

export const formatReport = (r: Report): string =>
  [
    '按节点：',
    ...Object.entries(r.byNode).map(([k, t]) => formatTotals(`  ${k}`, t)),
    '按角色：',
    ...Object.entries(r.byRole).map(([k, t]) => formatTotals(`  ${k}`, t)),
    formatTotals('合计', r.total),
  ].join('\n')
