// 改进页：从已结束的任务生成改进提案，查看证据和新旧对比，批准（写成约定的新版本）或拒绝。
import { useEffect, useState } from 'react'
import { KIND_NAMES, SIGNAL_NAMES, STATUS_NAMES } from '../../src/improve/labels.ts'
import type { GenerateResponse, ProposalDetail, ProposalInfo, WorkflowInfo } from './api.ts'
import { decideProposal, generateProposals, getProposal, listProposals, listTasks, listWorkflows } from './api.ts'
import { conventionHref, Diff } from './Conventions.tsx'
import { ago, duration, tokens } from './format.ts'

const PILL = { pending: 'waiting', approved: 'ok', rejected: 'error', stale: 'pending' } as const

export const parseImproveRoute = (hash: string): { id?: number } | undefined => {
  if (hash === '#/improve') return {}
  const m = /^#\/improve\/(\d{1,15})$/.exec(hash)
  return m === null ? undefined : { id: Number(m[1]) }
}

const firstLine = (s: string) => s.trim().split('\n')[0]!

function Generate(props: { onDone: () => void }) {
  const [workflows, setWorkflows] = useState<string[]>()
  const [workflow, setWorkflow] = useState('')
  const [tasks, setTasks] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenerateResponse>()
  // 选项：平台上的工作流，加上已结束的任务用过、但不在平台上的（例如来自 YAML 文件；它们的角色仍可能用平台上的模板）。
  useEffect(() => {
    const done = new Set(['done', 'failed', 'aborted'])
    void Promise.all([listWorkflows().catch((): WorkflowInfo[] => []), listTasks().catch(() => [])]).then(([ws, ts]) => {
      const names = [...new Set([...ws.map(w => w.name), ...ts.filter(t => done.has(t.status)).map(t => t.workflow)])]
      setWorkflows(names)
      setWorkflow(cur => (names.includes(cur) ? cur : names.includes('standard') ? 'standard' : names[0] ?? ''))
    })
  }, [])
  const run = async () => {
    setBusy(true)
    setResult(undefined)
    const r = await generateProposals(workflow, tasks.split(/[\s,，、]+/).filter(t => t !== ''))
    setBusy(false)
    setResult(r)
    props.onDone()
  }
  return (
    <section className="panel generate">
      <h2>生成提案</h2>
      <p className="muted">
        平台先从任务日志里用程序归纳证据（评审意见、检查失败、重新确认……），再交给只读的 improver 提出约定的修改。{''
        }提案要人批准才会生效；不能改权限（模型、写入范围、工具、MCP、检查命令）。一次生成是一次模型调用，通常要十几秒到一分钟。
      </p>
      <div className="generate-form">
        <label>
          <span>工作流</span>
          <select value={workflow} onChange={e => setWorkflow(e.target.value)} disabled={busy || workflows === undefined}>
            {(workflows ?? []).map(w => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
        <label className="grow">
          <span>任务（可选，空着就是这个工作流所有已结束的任务）</span>
          <input value={tasks} onChange={e => setTasks(e.target.value)} placeholder="t2611…, t2611…" disabled={busy} />
        </label>
        <button className="primary" onClick={() => void run()} disabled={busy || workflow === ''} aria-busy={busy}>{busy ? '生成中…' : '生成提案'}</button>
      </div>
      {result !== undefined && (!result.ok ? (
        <div className="notice warn" role="alert">
          {result.error}
          {result.call !== undefined && <>
            <span className="muted"> 这次模型调用 {duration(result.call.ms)}，输入 {tokens(result.call.usage.input)}，输出 {tokens(result.call.usage.output)}。回复的开头：</span>
            <pre className="signal-text">{result.call.replyHead}</pre>
          </>}
        </div>
      ) : (
        <div className="notice" role="status">
          {result.skipped ?? `生成了 ${result.created.length} 条待审批的提案${result.refused.length > 0 ? `，${result.refused.length} 条没有入库` : ''}。`}
          {result.call !== undefined && <span className="muted"> 模型调用 {duration(result.call.ms)}，输入 {tokens(result.call.usage.input)}，输出 {tokens(result.call.usage.output)}。</span>}
          {result.refused.length > 0 && (
            <ul className="refused">
              {result.refused.map(x => <li key={x.index}>第 {x.index + 1} 条{x.target === undefined ? '' : `（${KIND_NAMES[x.target.kind]}「${x.target.name}」）`}：{x.errors.join('；')}</li>)}
            </ul>
          )}
        </div>
      ))}
    </section>
  )
}

function List() {
  const [list, setList] = useState<ProposalInfo[]>()
  const [error, setError] = useState<string>()
  const load = () => listProposals().then(l => { setList(l); setError(undefined) }, e => setError((e as Error).message))
  useEffect(() => { void load() }, [])
  return (
    <div className="improve">
      <h1>改进</h1>
      <Generate onDone={() => void load()} />
      <section className="panel">
        <h2>提案</h2>
        {error && <p className="error">{error}</p>}
        {list === undefined ? <p className="muted">加载中…</p> : list.length === 0 ? <p className="muted">还没有提案。</p> : (
          <div className="table-wrap">
            <table className="tasks proposals">
              <thead><tr><th>提案</th><th>状态</th><th>要改的约定</th><th>理由</th><th>证据</th><th>生成</th></tr></thead>
              <tbody>
                {list.map(p => (
                  <tr key={p.id} onClick={() => (location.hash = `#/improve/${p.id}`)}>
                    <td><a href={`#/improve/${p.id}`}>#{p.id}</a></td>
                    <td><span className={`pill ${PILL[p.status]}`}>{STATUS_NAMES[p.status]}</span></td>
                    <td>{KIND_NAMES[p.target.kind]}「{p.target.name}」<span className="muted"> 第 {p.baseVersion} 版</span></td>
                    <td className="request">{firstLine(p.rationale)}</td>
                    <td>{p.evidence.length} 条</td>
                    <td className="muted">{ago(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Page(props: { id: number }) {
  const [p, setP] = useState<ProposalDetail>()
  const [error, setError] = useState<string>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()
  const load = () => getProposal(props.id).then(setP, e => setError((e as Error).message))
  useEffect(() => { void load() }, [props.id])
  if (error) return <p className="error">{error}</p>
  if (p === undefined) return <p className="muted">加载中…</p>
  const outdated = p.status === 'pending' && p.latestVersion !== undefined && p.latestVersion !== p.baseVersion
  const decide = async (action: 'approve' | 'reject') => {
    if (action === 'reject' && text.trim() === '') return setNotice({ ok: false, text: '拒绝需要写理由。' })
    setBusy(true)
    const r = await decideProposal(p.id, action, text)
    setBusy(false)
    if (r.ok) {
      const v = r.proposal.events.at(-1)?.version
      setNotice({ ok: true, text: action === 'approve' ? `已批准：${KIND_NAMES[p.target.kind]}「${p.target.name}」${v === undefined ? '有了新版本' : `现在是第 ${v} 版`}。之后创建的任务会用上它，进行中的任务不受影响。` : '已拒绝。' })
      setText('')
    } else setNotice({ ok: false, text: r.error })
    void load()
  }
  const targetHref = conventionHref(p.target.kind, p.target.name)
  return (
    <div className="improve proposal">
      <a href="#/improve" className="back">← 改进</a>
      <div className="summary-head">
        <h1>提案 #{p.id}</h1>
        <span className={`pill ${PILL[p.status]}`}>{STATUS_NAMES[p.status]}</span>
      </div>
      <div className="stats">
        <div><span>要改的约定</span><b><a href={targetHref}>{KIND_NAMES[p.target.kind]}「{p.target.name}」</a></b></div>
        <div><span>基于</span><b>第 {p.baseVersion} 版{p.latestVersion !== undefined && p.latestVersion !== p.baseVersion ? `（现在是第 ${p.latestVersion} 版）` : ''}</b></div>
        <div><span>范围</span><b>工作流 {p.scope.workflow}，{p.scope.tasks.length} 个任务</b></div>
        {p.generator !== undefined && <div><span>生成</span><b>{p.generator.model ?? ''} · {duration(p.generator.ms)} · 输出 {tokens(p.generator.usage.output)}</b></div>}
        <div><span>创建</span><b>{ago(p.createdAt)}（{p.actor}）</b></div>
      </div>

      <section className="panel">
        <h2>理由</h2>
        <p className="rationale">{p.rationale}</p>
      </section>

      <section className="panel">
        <h2>证据（{p.evidence.length} 条）</h2>
        <p className="muted">平台从任务日志里用程序归纳的事实，不是模型写的。点任务号查看那次任务。</p>
        <ul className="signals">
          {p.signals.map(s => (
            <li key={s.id}>
              <div className="signal-head">
                <span className="pill pending">{SIGNAL_NAMES[s.kind]}</span>
                <a href={`#/tasks/${s.task}`}>{s.task}</a>
                {s.node !== undefined && <span className="muted">节点 {s.node}</span>}
                {s.role !== undefined && <span className="muted">被评判的角色 {s.role}</span>}
                <code className="muted">{s.id}</code>
              </div>
              <pre className="signal-text">{s.text}</pre>
            </li>
          ))}
          {p.evidence.filter(id => !p.signals.some(s => s.id === id)).map(id => <li key={id} className="muted">{id}：找不到这条证据（任务可能已经不在了）</li>)}
        </ul>
      </section>

      <section className="panel">
        <h2>改动（第 {p.baseVersion} 版 → 新内容）</h2>
        {p.base === undefined ? <p className="muted">找不到第 {p.baseVersion} 版。</p> : <Diff before={p.base.content} after={p.content} />}
      </section>

      <section className="panel">
        <h2>审批</h2>
        {notice && <p className={`notice${notice.ok ? '' : ' warn'}`} role={notice.ok ? 'status' : 'alert'}>{notice.text}</p>}
        {p.status === 'pending' ? (
          <>
            {outdated && <p className="notice warn">目标已经是第 {p.latestVersion} 版，这条提案基于第 {p.baseVersion} 版：批准会失败并标为过期，请重新生成。</p>}
            <label className="decide">
              <span>备注（批准时可选）/ 理由（拒绝时必填）</span>
              <textarea value={text} onChange={e => setText(e.target.value)} rows={2} disabled={busy} />
            </label>
            <div className="actions">
              <button className="primary" disabled={busy} onClick={() => void decide('approve')}>批准，写成新版本</button>
              <button disabled={busy} onClick={() => void decide('reject')}>拒绝</button>
            </div>
          </>
        ) : null}
        <ol className="events">
          {p.events.map(e => (
            <li key={e.seq}>
              <span className={`pill ${PILL[e.status]}`}>{STATUS_NAMES[e.status]}</span> <span className="muted">{new Date(e.at).toLocaleString('zh-CN', { hour12: false })} · {e.actor}</span>
              {e.version !== undefined && <> · <a href={targetHref}>第 {e.version} 版</a></>}
              {e.reason !== undefined && <> · {e.reason}</>}
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}

export function Improve(props: { route: { id?: number } }) {
  return props.route.id === undefined ? <List /> : <Page key={props.route.id} id={props.route.id} />
}
