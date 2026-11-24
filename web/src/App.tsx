import { useEffect, useMemo, useRef, useState } from 'react'
import { bounds as boundsOf } from '../../src/trace/build.ts'
import type { ConventionKind, Span, TaskDetail, TaskSummary } from './api.ts'
import { getTask, listTasks, taskAction } from './api.ts'
import { Answer } from './Answer.tsx'
import { Changes } from './Changes.tsx'
import { Credentials } from './Credentials.tsx'
import { conventionHref, Conventions, parseConventionRoute } from './Conventions.tsx'
import { Detail } from './Detail.tsx'
import { Improve, parseImproveRoute } from './Improve.tsx'
import { Insights } from './Insights.tsx'
import { NewTask } from './NewTask.tsx'
import { Stages } from './Stages.tsx'
import { ago, duration, STATUS, statusClass, tokens } from './format.ts'
import { defaultOpen, TraceTree, visibleRows } from './Trace.tsx'

const useHash = () => {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

const LIVE = new Set(['running', 'waiting_user'])

function TaskList() {
  const [tasks, setTasks] = useState<TaskSummary[]>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    // 失败时显示错误，但不停止刷新；服务恢复后自动清掉错误。
    const load = () => listTasks().then(t => { setTasks(t); setError(undefined) }, e => setError(String(e.message)))
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])
  if (tasks === undefined) return error ? <p className="error">{error}（自动重试中）</p> : <p className="muted">加载中…</p>
  const head = (
    <div className="list-head">
      <h1>任务</h1>
      <a className="button primary" href="#/new">新建任务</a>
    </div>
  )
  if (tasks.length === 0) return <>{head}<p className="muted">还没有任务。点「新建任务」开始第一个。</p></>
  return (
    <>
    {head}
    {error && <p className="notice warn" role="alert">连接不上服务：{error}（每 5 秒自动重试）</p>}
    <table className="tasks">
      <thead>
        <tr><th>任务</th><th>状态</th><th>工作流</th><th>需求</th><th>更新</th></tr>
      </thead>
      <tbody>
        {tasks.map(t => (
          <tr key={t.id} onClick={() => (location.hash = `#/tasks/${t.id}`)}>
            <td><a href={`#/tasks/${t.id}`}>{t.id}</a></td>
            <td><span className={`pill ${statusClass(t.status)}`}>{STATUS[t.status]}</span></td>
            <td>{t.workflow}</td>
            <td className="request">{t.request.split('\n')[0]}</td>
            <td className="muted">{ago(t.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </>
  )
}

const collect = (s: Span): string[] => [s.id, ...s.children.flatMap(collect)]

/** 任务创建时用到的某一类约定及其版本，链到团队约定页。一个都没有时不占位置。 */
const used = (label: string, kind: ConventionKind, items: { name: string; version: number }[] | undefined) =>
  items === undefined || items.length === 0 ? null : (
    <div key={kind}>
      <span>{label}</span>
      <b>{items.map((x, i) => <span key={x.name}>{i > 0 && '、'}<a href={conventionHref(kind, x.name)}>{x.name} · 第 {x.version} 版</a></span>)}</b>
    </div>
  )

const find = (s: Span, id: string | undefined): Span | undefined =>
  id === undefined ? undefined : s.id === id ? s : s.children.map(c => find(c, id)).find(Boolean)

function TaskPage(props: { id: string }) {
  const [task, setTask] = useState<TaskDetail>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<Set<string>>()
  const [selected, setSelected] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const [reload, setReload] = useState(0)
  const [notice, setNotice] = useState<string>()
  // 操作提示只停留几秒，过时的提示（例如"已回答，任务继续"）不会一直挂在页面上。
  useEffect(() => {
    if (notice === undefined) return
    const t = setTimeout(() => setNotice(undefined), 6000)
    return () => clearTimeout(t)
  }, [notice])
  const [acting, setActing] = useState(false)
  const ACTION = { resume: '已继续运行。', retry: '已重新开始失败的那一步。', abort: '已中止。' }
  const act = async (action: 'resume' | 'retry' | 'abort') => {
    setActing(true)
    const r = await taskAction(props.id, action)
    setActing(false)
    setNotice(r.ok ? ACTION[action] : r.error)
    setReload(n => n + 1)
  }
  const seen = useRef(new Set<string>())

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let stopped = false
    const load = async () => {
      try {
        const t = await getTask(props.id)
        if (stopped) return
        setTask(t)
        setNow(Date.now())
        // 只自动展开第一次出现的行；用户手动收起的不会在刷新时被重新展开。
        const base = defaultOpen(t.trace)
        const fresh = [...base].filter(id => !seen.current.has(id))
        collect(t.trace).forEach(id => seen.current.add(id))
        setOpen(prev => (prev === undefined ? base : new Set([...prev, ...fresh])))
        setError(undefined)
        if (LIVE.has(t.status)) timer = setTimeout(load, 2000)
      } catch (e) {
        if (stopped) return
        // 服务重启或网络中断时不停止刷新：显示错误，2 秒后再试。
        setError((e as Error).message)
        timer = setTimeout(load, 2000)
      }
    }
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [props.id, reload])

  const rows = useMemo(() => (task && open ? visibleRows(task.trace, open) : []), [task, open])
  const bounds = useMemo(() => (task === undefined ? { start: 0, end: 1 } : boundsOf(task.trace, now)), [task, now])

  if (task === undefined || open === undefined) return error ? <p className="error">{error}（自动重试中）</p> : <p className="muted">加载中…</p>
  const r = task.report.total
  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const expandAll = () => {
    const all = new Set<string>()
    const walk = (s: Span) => { all.add(s.id); s.children.forEach(walk) }
    walk(task.trace)
    setOpen(all)
  }
  return (
    <div className="task-page">
      <section className="summary">
        <div className="summary-head">
          <a href="#/" className="back">← 任务列表</a>
          <h1>{task.id}</h1>
          <span className={`pill ${statusClass(task.status)}`}>{STATUS[task.status]}</span>
          {LIVE.has(task.status) && <span className="muted live-note">每 2 秒自动刷新</span>}
        </div>
        <p className="request">{task.request}</p>
        <div className="stats">
          <div>
            <span>工作流</span>
            <b>{task.conventions?.workflow.version === undefined ? task.workflow
              : <a href={conventionHref('workflow', task.workflow)}>{task.workflow} · 第 {task.conventions.workflow.version} 版</a>}</b>
          </div>
          {used('团队约定', 'doc', task.conventions?.docs)}
          {used('Agent 模板', 'template', task.conventions?.templates)}
          {used('技能', 'skill', task.conventions?.skills)}
          <div><span>当前位置</span><b>{task.position}</b></div>
          <div><span>已完成调用</span><b>{r.calls} 次</b></div>
          <div><span>agent 耗时</span><b>{duration(r.ms)}</b></div>
          <div><span>输入 / 输出</span><b>{tokens(r.usage.input)} / {tokens(r.usage.output)}</b></div>
          <div><span>缓存读 / 写</span><b>{tokens(r.usage.cacheRead)} / {tokens(r.usage.cacheWrite)}</b></div>
        </div>
        <dl className="where" aria-label="仓库">
          <dt>仓库</dt><dd className="mono">{task.repo}</dd>
          <dt>分支</dt><dd className="mono">{task.branch}</dd>
          <dt>工作目录（worktree）</dt><dd className="mono">{task.worktree}</dd>
          <dt>基线提交</dt><dd className="mono">{task.baseSha.slice(0, 12)}</dd>
        </dl>
        {task.question && (
          <Answer
            key={task.question.id}
            task={task}
            onAnswered={resumeNeeded => {
              setNotice(resumeNeeded ? '已回答。没有程序在运行这个任务，点「继续」让它接着跑。' : '已回答，任务继续。')
              setReload(n => n + 1)
            }}
          />
        )}
        {error && <p className="notice warn" role="alert">连接不上服务：{error}（每 2 秒自动重试）</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {LIVE.has(task.status) && !task.runnerAlive && (
          <p className="notice warn">没有程序在运行这个任务{task.question?.source === 'agent' ? '（这个提问来自上一次运行，回答后点「继续」）' : ''}。点「继续」接着跑。</p>
        )}
        {task.failure && (
          <div className="failure" role="alert">
            <b>失败原因</b>
            <div className="failure-text">{task.failure}{'\n'}日志：<span className="mono">{task.logPath}</span>（<a href={`/api/tasks/${encodeURIComponent(task.id)}/log`} target="_blank" rel="noreferrer">查看日志</a>）</div>
          </div>
        )}
        <div className="actions">
          {LIVE.has(task.status) && !task.runnerAlive && <button className="primary" disabled={acting} onClick={() => void act('resume')}>继续</button>}
          {task.status === 'failed' && <button className="primary" disabled={acting} onClick={() => void act('retry')}>重试</button>}
          {LIVE.has(task.status) && <button disabled={acting} onClick={() => { if (confirm('中止这个任务？正在进行的这一轮会跑完，之后不再继续。')) void act('abort') }}>中止</button>}
          <a className="button" href={`/api/tasks/${encodeURIComponent(task.id)}/log`} target="_blank" rel="noreferrer">查看日志</a>
        </div>
      </section>
      <Stages metrics={task.metrics} runnerAlive={task.runnerAlive} />
      <Changes id={task.id} version={r.calls} />
      <div className="toolbar">
        <button onClick={expandAll}>全部展开</button>
        <button onClick={() => setOpen(defaultOpen(task.trace))}>收起到调用</button>
      </div>
      <div className="split">
        <TraceTree rows={rows} open={open} selected={selected} bounds={bounds} now={now} onToggle={toggle} onSelect={setSelected} />
        <Detail span={find(task.trace, selected)} now={now} />
      </div>
    </div>
  )
}

export function App() {
  const hash = useHash()
  const id = /^#\/tasks\/([\w-]+)/.exec(hash)?.[1]
  const conv = parseConventionRoute(hash)
  const improve = parseImproveRoute(hash)
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">Eos Workbench</a>
        <nav className="topnav">
          <a href="#/" className={conv === undefined && improve === undefined && hash !== '#/insights' && hash !== '#/credentials' ? 'active' : ''}>任务</a>
          <a href="#/insights" className={hash === '#/insights' ? 'active' : ''}>统计</a>
          <a href="#/improve" className={improve !== undefined ? 'active' : ''}>改进</a>
          <a href="#/conventions" className={conv !== undefined ? 'active' : ''}>团队约定</a>
          <a href="#/credentials" className={hash === '#/credentials' ? 'active' : ''}>凭据</a>
        </nav>
      </header>
      <main className={conv === undefined ? '' : 'wide'}>
        {conv !== undefined ? <Conventions route={conv} /> : improve !== undefined ? <Improve route={improve} /> : hash === '#/insights' ? <Insights /> : hash === '#/credentials' ? <Credentials /> : hash === '#/new' ? <NewTask /> : id === undefined ? <TaskList /> : <TaskPage key={id} id={id} />}
      </main>
    </>
  )
}
