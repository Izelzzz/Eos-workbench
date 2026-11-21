// 任务页的阶段表：每个阶段的调用、token 和时长构成，横条按最长的阶段等比例画，最慢的阶段标出来。
import type { TaskDetail } from './api.ts'
import { duration, tokens } from './format.ts'

type Metrics = TaskDetail['metrics']
type Stage = Metrics['stages'][number]

/** 时长的组成部分：顺序就是横条从左到右的顺序。 */
const PARTS = [
  { key: 'agentMs', label: 'agent', cls: 'p-agent' },
  { key: 'runningMs', label: '进行中', cls: 'p-running' },
  { key: 'checkMs', label: '检查', cls: 'p-check' },
  { key: 'waitUserMs', label: '等用户', cls: 'p-wait' },
  { key: 'blockedMs', label: '阻塞', cls: 'p-blocked' },
  { key: 'overheadMs', label: '平台开销', cls: 'p-overhead' },
] as const

const Bar = (props: { stage: Stage; max: number }) => (
  <div className="stage-bar" style={{ width: `${props.max === 0 ? 0 : (props.stage.wallMs / props.max) * 100}%` }}>
    {PARTS.map(p => props.stage[p.key] > 0 && (
      <span key={p.key} className={p.cls} style={{ flexGrow: props.stage[p.key] }} title={`${p.label} ${duration(props.stage[p.key])}`} />
    ))}
  </div>
)

export const Stages = (props: { metrics: Metrics }) => {
  const { stages, total } = props.metrics
  if (stages.length === 0) return null
  const max = Math.max(...stages.map(s => s.wallMs))
  const slowest = stages.length > 1 && max > 0 ? stages.find(s => s.wallMs === max)?.node : undefined
  return (
    <section className="stages">
      <div className="stages-head">
        <h2>各阶段耗时</h2>
        <div className="legend">{PARTS.map(p => <span key={p.key}><i className={p.cls} />{p.label}</span>)}</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>阶段</th><th className="num">调用</th><th className="num">输入 / 输出 / 缓存读</th><th className="bar-col">时长构成</th>
            {PARTS.map(p => <th key={p.key} className="num">{p.label}</th>)}
            <th className="num">总时长</th>
          </tr>
        </thead>
        <tbody>
          {stages.map(s => (
            <tr key={s.node} className={s.node === slowest ? 'slowest' : undefined}>
              <td>
                <b>{s.node}</b>
                {s.open && <span className="tag running">进行中</span>}
                {s.node === slowest && <span className="tag">最慢</span>}
              </td>
              <td className="num">{s.calls}{s.checks > 0 && <span className="muted"> · 检查 {s.checks}</span>}</td>
              <td className="num">{tokens(s.usage.input)} / {tokens(s.usage.output)} / {tokens(s.usage.cacheRead)}</td>
              <td className="bar-col"><Bar stage={s} max={max} /></td>
              {PARTS.map(p => <td key={p.key} className={`num${s[p.key] === 0 ? ' muted' : ''}`}>{duration(s[p.key])}</td>)}
              <td className="num"><b>{duration(s.wallMs)}</b></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>合计</td>
            <td className="num">{total.calls}</td>
            <td className="num">{tokens(total.usage.input)} / {tokens(total.usage.output)} / {tokens(total.usage.cacheRead)}</td>
            <td />
            {PARTS.map(p => <td key={p.key} className="num">{duration(total[p.key])}</td>)}
            <td className="num"><b>{duration(total.wallMs)}</b></td>
          </tr>
        </tfoot>
      </table>
      <p className="muted stages-note">
        任务总时长 {duration(props.metrics.elapsedMs)}
        {props.metrics.betweenMs > 0 && <>，其中 {duration(props.metrics.betweenMs)} 不在任何阶段里（阶段之间的间隔，例如平台停着或重启续跑）</>}
        。「进行中」是正在跑、还没有结果的调用或检查，结束后归到 agent 或检查。
      </p>
    </section>
  )
}
