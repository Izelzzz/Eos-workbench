// 新建任务：选仓库、选工作流、写需求，提交后跳到任务页，任务在服务里开始运行。
import { useEffect, useState } from 'react'
import type { WorkflowInfo } from './api.ts'
import { createTask, listWorkflows } from './api.ts'

const REPO_KEY = 'eos.lastRepo'

/** 记住上次用的仓库路径；浏览器存储不可用时（隐私模式等）就不记。 */
const remembered = (): string => {
  try {
    return localStorage.getItem(REPO_KEY) ?? ''
  } catch {
    return ''
  }
}
const remember = (repo: string) => {
  try {
    localStorage.setItem(REPO_KEY, repo)
  } catch {
    // 记不住也不影响创建任务
  }
}

export function NewTask() {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>()
  const [repo, setRepo] = useState(remembered)
  const [workflow, setWorkflow] = useState('feature')
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    listWorkflows().then(setWorkflows, e => setError(`加载工作流失败：${(e as Error).message}`))
  }, [])

  const chosen = workflows?.find(w => w.name === workflow)
  const submit = async () => {
    setBusy(true)
    setError(undefined)
    const r = await createTask({ repo, workflow, request })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    remember(repo)
    location.hash = `#/tasks/${r.id}`
  }

  return (
    <form className="new-task" aria-label="新建任务" onSubmit={e => { e.preventDefault(); void submit() }}>
      <a href="#/" className="back">← 任务列表</a>
      <h1>新建任务</h1>
      <label>
        <span>仓库路径</span>
        <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="/path/to/your/repo（本机上的 git 仓库）" required spellCheck={false} />
        <small className="muted">任务会在这个仓库上新建分支 eos/&lt;任务id&gt; 和独立的 worktree，不会改动你当前的工作目录。</small>
      </label>
      <label>
        <span>工作流</span>
        <select value={workflow} onChange={e => setWorkflow(e.target.value)}>
          {(workflows ?? [{ name: 'feature', nodes: [] }]).map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
        </select>
        {chosen && <small className="muted">{chosen.description}{chosen.nodes.length > 0 ? `（${chosen.nodes.join(' → ')}）` : ''}</small>}
      </label>
      <label>
        <span>需求</span>
        <textarea value={request} onChange={e => setRequest(e.target.value)} rows={7} placeholder="写清楚要做什么、验收标准是什么；不确定的地方，agent 会在规划时问你。" required />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div>
        <button type="submit" className="primary" disabled={busy}>{busy ? '创建中…' : '创建并开始'}</button>
      </div>
    </form>
  )
}
