// 修正入口：已完成的任务可以提交一条「改正或补充」，交给某个 agent 节点在原来的会话和 worktree 里继续做。
// 这里也列出历次修正：第几次、交给谁、内容、进行到哪、节点的回复和这次修正的提交改到的文件。
import { useState } from 'react'
import type { TaskDetail } from './api.ts'
import { correctTask } from './api.ts'

const STATE = { running: ['running', '进行中'], done: ['ok', '完成'], failed: ['error', '失败（重试后接着做）'], aborted: ['error', '已中止，没做完'] } as const

export function Corrections(props: { task: TaskDetail; onSubmitted: (resumeNeeded: boolean) => void }) {
  const t = props.task
  const [picked, setPicked] = useState<string>()
  // 默认交给最后一个 agent 节点（通常是写代码的那个）。面板可能在任务完成前就挂上了（那时还没有可选的节点），
  // 所以每次渲染时按现在的可选节点算：选过的还在就用它，否则用默认的。
  const node = picked !== undefined && t.correctable.includes(picked) ? picked : (t.correctable.at(-1) ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  if (t.corrections.length === 0 && t.correctable.length === 0) return null

  const submit = async () => {
    if (text.trim() === '') return setError('写下要改正或补充的内容')
    setBusy(true)
    setError(undefined)
    try {
      const r = await correctTask(t.id, { node, text })
      if (r.ok) {
        setText('')
        props.onSubmitted(r.resumeNeeded)
      } else setError(r.error)
    } catch (e) {
      setError(`提交失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="corrections" aria-label="修正">
      <h2>修正</h2>
      {t.corrections.length > 0 && (
        <ol className="correction-list">
          {t.corrections.map(c => (
            <li key={c.round}>
              <div className="correction-head">
                <b>第 {c.round} 次修正</b>
                <span className="muted">交给「{c.node}」</span>
                <span className={`pill ${STATE[c.state][0]}`}>{STATE[c.state][1]}</span>
              </div>
              <p className="correction-text">{c.text}</p>
              {c.replies.length > 0 && (
                <details>
                  <summary>
                    「{c.node}」的回复（{c.replies.length} 次）
                  </summary>
                  {c.replies.map((r, i) => (
                    <pre key={i}>{r}</pre>
                  ))}
                </details>
              )}
              <p className="muted correction-files">{c.files.length === 0 ? '这次修正没有改动文件' : `改动的文件：${c.files.join('、')}`}</p>
            </li>
          ))}
        </ol>
      )}
      {t.correctable.length > 0 && (
        <form
          className="correction-form"
          onSubmit={e => {
            e.preventDefault()
            void submit()
          }}
        >
          <p className="muted">
            任务已完成。发现要改正或补充的地方，写在这里：交给选中的节点在原来的会话和工作目录里继续做（不是重新跑一遍），改完重跑程序检查
            {t.links.some(l => l.kind === 'pull-request') ? '，推到同一个分支、更新同一个 PR' : ''}。
          </p>
          <label>
            交给
            <select value={node} disabled={busy} onChange={e => setPicked(e.target.value)}>
              {t.correctable.map(n => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <textarea value={text} disabled={busy} rows={3} placeholder="要改正或补充什么" aria-label="改正或补充" onChange={e => setText(e.target.value)} />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '提交中…' : '提交修正'}
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
