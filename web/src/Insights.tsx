// 统计页：跨任务按工作流、阶段、Agent 模板汇总 token 和时长，标出每个工作流最耗时的阶段。
import { useEffect, useState } from 'react'
import type { Insights as Data } from './api.ts'
import { getInsights } from './api.ts'
import { conventionHref } from './Conventions.tsx'
import { duration, tokens } from './format.ts'
import { Bar, PARTS } from './Stages.tsx'

const PART_LABEL = Object.fromEntries(PARTS.map(p => [p.key, p.label])) as Record<(typeof PARTS)[number]['key'], string>
const pct = (x: number) => `${Math.round(x * 100)}%`
const taskLink = (id: string, ms: number) => <a href={`#/tasks/${id}`}>{duration(ms)}</a>

export function Insights() {
  const [data, setData] = useState<Data>()
  const [error, setError] = useState<string>()
  useEffect(() => { getInsights().then(setData, e => setError((e as Error).message)) }, [])
  if (error) return <p className="error">{error}</p>
  if (data === undefined) return <p className="muted">加载中…</p>
  const t = data.tasks
  if (t.total === 0) return <p className="muted">还没有任务。</p>
  const stageMax = Math.max(...data.byStage.map(s => s.wallMs))
  const wfMax = Math.max(...data.byWorkflow.map(w => w.wallMs))
  return (
    <div className="insights">
      <h1>统计</h1>
      <p className="muted">
        共 {t.total} 个任务：已完成 {t.done}，进行中 {t.running + t.waiting_user}（其中等回答 {t.waiting_user}），失败 {t.failed}，已中止 {t.aborted}。
        进行中的任务算到现在。时长是各阶段时长之和，不含阶段之间的间隔。
      </p>

      {data.bottlenecks.length > 0 && (
        <section className="panel">
          <h2>瓶颈</h2>
          <ul className="bottlenecks">
            {data.bottlenecks.map(b => (
              <li key={b.workflow}>
                工作流 <b>{b.workflow}</b> 最耗时的阶段是 <b>{b.node}</b>：占所有阶段时长的 <b>{pct(b.share)}</b>（{duration(b.wallMs)}），
                其中「{PART_LABEL[b.part]}」最多，{duration(b.partMs)}（{pct(b.partMs / b.wallMs)}）。
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel stages">
        <h2>按工作流</h2>
        <table>
          <thead><tr><th>工作流</th><th className="num">任务</th><th className="num">调用</th><th className="num">输入 / 输出 / 缓存读</th><th className="bar-col">时长构成</th><th className="num">中位数</th><th className="num">最长</th><th className="num">阶段之外</th><th className="num">合计</th></tr></thead>
          <tbody>
            {data.byWorkflow.map(w => (
              <tr key={w.workflow}>
                <td><b>{w.workflow}</b></td><td className="num">{w.tasks}</td><td className="num">{w.calls}</td>
                <td className="num">{tokens(w.usage.input)} / {tokens(w.usage.output)} / {tokens(w.usage.cacheRead)}</td>
                <td className="bar-col"><Bar stage={w} max={wfMax} /></td>
                <td className="num">{duration(w.medianMs)}</td><td className="num">{taskLink(w.slowest.task, w.maxMs)}</td>
                <td className="num">{duration(w.betweenMs)}</td><td className="num"><b>{duration(w.wallMs)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel stages">
        <div className="stages-head">
          <h2>按阶段（从最耗时的开始）</h2>
          <div className="legend">{PARTS.map(p => <span key={p.key}><i className={p.cls} />{p.label}</span>)}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>工作流 / 阶段</th><th className="num">任务</th><th className="num">调用</th><th className="num">输入 / 输出</th><th className="bar-col">时长构成</th>
              {PARTS.map(p => <th key={p.key} className="num">{p.label}</th>)}
              <th className="num">中位数</th><th className="num">最长</th><th className="num">合计</th>
            </tr>
          </thead>
          <tbody>
            {data.byStage.map(s => (
              <tr key={`${s.workflow}/${s.node}`}>
                <td><span className="muted">{s.workflow} / </span><b>{s.node}</b></td><td className="num">{s.tasks}</td><td className="num">{s.calls}</td>
                <td className="num">{tokens(s.usage.input)} / {tokens(s.usage.output)}</td>
                <td className="bar-col"><Bar stage={s} max={stageMax} /></td>
                {PARTS.map(p => <td key={p.key} className={`num${s[p.key] === 0 ? ' muted' : ''}`}>{duration(s[p.key])}</td>)}
                <td className="num">{duration(s.medianMs)}</td><td className="num">{taskLink(s.slowest.task, s.maxMs)}</td><td className="num"><b>{duration(s.wallMs)}</b></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel stages">
        <h2>按 Agent 模板</h2>
        <table>
          <thead><tr><th>模板</th><th className="num">任务</th><th className="num">调用</th><th className="num">输入 / 输出 / 缓存读</th><th className="num">agent 时长</th><th className="num">每次调用平均</th><th className="num">每次调用输出</th></tr></thead>
          <tbody>
            {data.byTemplate.map(r => (
              <tr key={`${r.template}/${r.name}`}>
                <td>
                  {r.template ? <a href={conventionHref('template', r.name)}><b>{r.name}</b></a> : <span>{r.name}</span>}
                  {r.template ? <span className="muted"> · 第 {r.versions.join('、')} 版</span> : <span className="tag">工作流里直接写的角色</span>}
                </td>
                <td className="num">{r.tasks}</td><td className="num">{r.calls}</td>
                <td className="num">{tokens(r.usage.input)} / {tokens(r.usage.output)} / {tokens(r.usage.cacheRead)}</td>
                <td className="num">{duration(r.agentMs)}</td>
                <td className="num">{duration(Math.round(r.agentMs / r.calls))}</td>
                <td className="num">{tokens(Math.round(r.usage.output / r.calls))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
