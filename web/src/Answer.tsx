// 待回答的问题：选项按钮一键回答，也可以输入自己的回答。
import { useState } from 'react'
import type { TaskDetail } from './api.ts'
import { answerQuestion } from './api.ts'

export function Answer(props: { task: TaskDetail; onAnswered: (resumeNeeded: boolean) => void }) {
  const q = props.task.question!
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const send = async (value: string) => {
    if (value.trim() === '') return setError('回答不能为空')
    setBusy(true)
    setError(undefined)
    try {
      const r = await answerQuestion(props.task.id, q.id, value)
      if (r.ok) {
        setText('')
        props.onAnswered(r.resumeNeeded)
      } else setError(r.error)
    } catch (e) {
      setError(`提交失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="question" aria-label="回答提问" onSubmit={e => { e.preventDefault(); void send(text) }}>
      <div className="question-head">
        <b>{q.source === 'agent' ? 'agent 在等你回答' : '对话循环需要你的指示'}</b>
        <span className="muted">（{q.id}）</span>
      </div>
      <p className="question-text">{q.text}</p>
      {q.options && q.options.length > 0 && (
        <div className="options">
          {q.options.map(o => (
            <button key={o} type="button" disabled={busy} onClick={() => void send(o)}>{o}</button>
          ))}
        </div>
      )}
      <div className="free">
        <textarea
          value={text}
          disabled={busy}
          rows={2}
          placeholder={q.options ? '或者输入你自己的回答…' : '输入你的回答…'}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(text) }}
        />
        <button type="submit" className="primary" disabled={busy}>{busy ? '提交中…' : '回答'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  )
}
