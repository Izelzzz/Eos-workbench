import { useEffect, useMemo, useRef, useState } from 'react'
import { bounds as boundsOf } from '../../src/trace/build.ts'
import type { Span, TaskDetail, TaskSummary } from './api.ts'
import { getTask, listTasks } from './api.ts'
import { Detail } from './Detail.tsx'
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
    const load = () => listTasks().then(setTasks, e => setError(String(e.message)))
    load()
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [])
  if (error) return <p className="error">{error}</p>
  if (tasks === undefined) return <p className="muted">加载中…</p>
  if (tasks.length === 0) return <p className="muted">还没有任务。用 <code>npm run eos -- run --repo &lt;仓库&gt; "&lt;需求&gt;"</code> 创建一个。</p>
  return (
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
  )
}

const collect = (s: Span): string[] => [s.id, ...s.children.flatMap(collect)]

const find = (s: Span, id: string | undefined): Span | undefined =>
  id === undefined ? undefined : s.id === id ? s : s.children.map(c => find(c, id)).find(Boolean)

function TaskPage(props: { id: string }) {
  const [task, setTask] = useState<TaskDetail>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<Set<string>>()
  const [selected, setSelected] = useState<string>()
  const [now, setNow] = useState(Date.now())
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
        if (!stopped) setError((e as Error).message)
      }
    }
    void load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [props.id])

  const rows = useMemo(() => (task && open ? visibleRows(task.trace, open) : []), [task, open])
  const bounds = useMemo(() => (task === undefined ? { start: 0, end: 1 } : boundsOf(task.trace, now)), [task, now])

  if (error) return <p className="error">{error}</p>
  if (task === undefined || open === undefined) return <p className="muted">加载中…</p>
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
          <div><span>工作流</span><b>{task.workflow}</b></div>
          <div><span>当前位置</span><b>{task.position}</b></div>
          <div><span>调用</span><b>{r.calls} 次</b></div>
          <div><span>agent 耗时</span><b>{duration(r.ms)}</b></div>
          <div><span>输入 / 输出</span><b>{tokens(r.usage.input)} / {tokens(r.usage.output)}</b></div>
          <div><span>缓存读 / 写</span><b>{tokens(r.usage.cacheRead)} / {tokens(r.usage.cacheWrite)}</b></div>
          <div><span>分支</span><b className="mono">{task.branch}</b></div>
        </div>
        {task.question && (
          <div className="question">
            <b>待回答（{task.question.id}）</b>：{task.question.text}
            {task.question.options && <div className="muted">选项：{task.question.options.join(' / ')}</div>}
            <div className="muted">回答：<code>npm run eos -- answer {task.id} "&lt;回答&gt;"</code></div>
          </div>
        )}
        {task.failure && <div className="failure"><b>失败原因</b>：{task.failure}</div>}
      </section>
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
  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">Eos Workbench</a>
        <span className="muted">多 agent 工作流</span>
      </header>
      <main>{id === undefined ? <TaskList /> : <TaskPage key={id} id={id} />}</main>
    </>
  )
}
