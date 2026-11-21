// 改进前后对比的表格：统计页和提案详情页共用。只列数字；样本不足时不算变化、不下结论。
import type { Comparison, OutcomeKey } from '../../src/engine/compare.ts'
import { duration, tokens } from './format.ts'

const ROWS: { key: OutcomeKey; label: string; fmt: (n: number) => string }[] = [
  { key: 'reviews', label: '评审轮次', fmt: n => n.toFixed(1) },
  { key: 'checkFailures', label: '检查失败', fmt: n => n.toFixed(1) },
  { key: 'fixes', label: '补齐次数', fmt: n => n.toFixed(1) },
  { key: 'signals', label: '证据条数', fmt: n => n.toFixed(1) },
  { key: 'tokens', label: 'token（输入 + 输出）', fmt: n => tokens(Math.round(n)) },
  { key: 'agentMs', label: 'agent 时长', fmt: n => duration(n) },
]

const pct = (x: number) => `${Math.round(x * 100)}%`
const change = (before: number, after: number) => (before === 0 ? (after === 0 ? '0' : '新出现') : `${after >= before ? '+' : ''}${pct((after - before) / before)}`)
const taskLinks = (ids: string[]) => ids.length === 0 ? <span className="muted">无</span> : ids.map((id, i) => <span key={id}>{i > 0 && '、'}<a href={`#/tasks/${id}`}>{id}</a></span>)

export function ComparisonTable(props: { c: Comparison }) {
  const { before: b, after: a, enough } = props.c
  return (
    <div className="compare">
      {!enough && <p className="notice warn">样本不足：每组至少要 {props.c.min} 个已结束的任务（现在改进前 {b.tasks} 个、改进后 {a.tasks} 个），只列数字，不算变化。</p>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>每个任务平均</th><th className="num">改进前（第 {props.c.version} 版之前）</th><th className="num">改进后（第 {props.c.version} 版起）</th><th className="num">变化</th></tr></thead>
          <tbody>
            <tr><td>任务数</td><td className="num">{b.tasks}</td><td className="num">{a.tasks}</td><td className="num muted">—</td></tr>
            <tr>
              <td>完成率</td>
              <td className="num">{b.tasks === 0 ? '—' : pct(b.done / b.tasks)}</td><td className="num">{a.tasks === 0 ? '—' : pct(a.done / a.tasks)}</td><td className="num muted">—</td>
            </tr>
            {ROWS.map(r => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className="num">{b.tasks === 0 ? '—' : r.fmt(b.mean[r.key])}</td>
                <td className="num">{a.tasks === 0 ? '—' : r.fmt(a.mean[r.key])}</td>
                <td className="num">{enough ? change(b.mean[r.key], a.mean[r.key]) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">改进前：{taskLinks(b.outcomes.map(o => o.task))}。改进后：{taskLinks(a.outcomes.map(o => o.task))}。{''
        }{props.c.unknown.length > 0 && <>版本未知、不计入：{taskLinks(props.c.unknown)}。</>}{''
        }两组任务的需求不同、模型有随机性，差异不一定是这次修改带来的。</p>
    </div>
  )
}
