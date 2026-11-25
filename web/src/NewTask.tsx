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
  const [workflow, setWorkflow] = useState('standard')
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
    <form
      className="new-task"
      aria-label="新建任务"
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <a href="#/" className="back">
        ← 任务列表
      </a>
      <h1>新建任务</h1>
      <label>
        <span>仓库</span>
        <input value={repo} onChange={e => setRepo(e.target.value)} placeholder="https://github.com/<owner>/<repo>，或平台所在机器上的仓库路径" required spellCheck={false} />
        <small className="muted">
          GitHub 仓库：平台克隆到自己的数据目录，在默认分支的最新提交上新建分支 eos/&lt;任务id&gt;；私有仓库要先在<a href="#/credentials">凭据页</a>添加名字为 github.com 的 Git
          令牌。本机路径：在这个仓库上新建分支和独立的 worktree，不改动它的工作目录。
        </small>
      </label>
      <label>
        <span>工作流</span>
        <select value={workflow} onChange={e => setWorkflow(e.target.value)}>
          {(workflows ?? [{ name: workflow, version: 0, nodes: [] }]).map(w => (
            <option key={w.name} value={w.name}>
              {w.version > 0 ? `${w.name} · 第 ${w.version} 版` : w.name}
            </option>
          ))}
        </select>
        {chosen && (
          <small className="muted">
            {chosen.description}
            {chosen.nodes.length > 0 ? `（${chosen.nodes.join(' → ')}）` : ''} <a href={`#/conventions/workflow/${encodeURIComponent(chosen.name)}`}>查看或修改</a>
          </small>
        )}
      </label>
      <label>
        <span>需求</span>
        <textarea value={request} onChange={e => setRequest(e.target.value)} rows={7} placeholder="写清楚要做什么、验收标准是什么；不确定的地方，agent 会在规划时问你。" required />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? '创建中…' : '创建并开始'}
        </button>
      </div>
    </form>
  )
}
