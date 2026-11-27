// 卡点面板：任务停在卡点上时显示验收什么、由谁验收、被验收的产出和这个卡点上已有的结论。
// 人验收时可以在这里通过，或者写下意见后打回（交回被验收的节点按意见修改，改完回到卡点）。
import { useState } from 'react'
import type { TaskDetail } from './api.ts'
import { decideGate } from './api.ts'

const PHASE = { decide: '等验收人给结论', amend: '被验收方按意见修改中', check: '修改后重跑检查中', ask: '等你给出指示（见上面的问题）' }

export function Gate(props: { task: TaskDetail; onDecided: (pass: boolean, resumeNeeded: boolean) => void }) {
  const g = props.task.gate!
  const [comment, setComment] = useState('')
  /** 正在提交的是哪个结论：提交中的提示显示在那个按钮上。 */
  const [busy, setBusy] = useState<'pass' | 'back'>()
  const [error, setError] = useState<string>()

  const send = async (pass: boolean) => {
    if (!pass && comment.trim() === '') return setError('打回时要写明意见：哪里不对、要怎么改')
    setBusy(pass ? 'pass' : 'back')
    setError(undefined)
    try {
      const r = await decideGate(props.task.id, { gate: g.node, round: g.round, pass, comment })
      if (r.ok) {
        setComment('')
        props.onDecided(pass, r.resumeNeeded)
      } else setError(r.error)
    } catch (e) {
      setError(`提交失败：${(e as Error).message}`)
    } finally {
      setBusy(undefined)
    }
  }

  const showChanges = () => document.querySelector('section.changes')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <section className={`gate${g.waiting ? ' waiting' : ''}`} aria-label="验收卡点">
      <div className="gate-head">
        <b>
          卡点「{g.node}」· 第 {g.round} 次验收
        </b>
        <span className="muted">
          验收「{g.with}」，验收人：{g.approver}
        </span>
      </div>
      <p className="gate-state">{g.waiting ? '等待验收：请查看下面的产出和改动，然后通过或打回。' : PHASE[g.phase]}</p>
      {g.task.trim() !== '' && <p className="gate-task">{g.task}</p>}
      <details className="gate-output" open={g.waiting}>
        <summary>「{g.with}」的产出</summary>
        <pre>{g.output ?? '（没有产出）'}</pre>
      </details>
      <button type="button" className="link" onClick={showChanges}>
        查看改动 ↓
      </button>
      {g.decisions.length > 0 && (
        <ol className="gate-history" aria-label="验收记录">
          {g.decisions.map(d => (
            <li key={`${d.round}-${d.at}`}>
              <span className={`pill ${d.pass ? 'ok' : 'error'}`}>{d.pass ? '通过' : '打回'}</span> 第 {d.round} 次 · {d.by === 'human' ? '人' : d.by}
              {d.comment !== '' && <div className="gate-comment">{d.comment}</div>}
            </li>
          ))}
        </ol>
      )}
      {g.waiting && (
        <form
          className="gate-form"
          onSubmit={e => {
            e.preventDefault()
            void send(false)
          }}
        >
          <textarea
            value={comment}
            disabled={busy !== undefined}
            rows={3}
            placeholder="打回时写明意见：哪里不对、要怎么改。通过时可以留空，也可以写备注。"
            aria-label="验收意见"
            onChange={e => setComment(e.target.value)}
          />
          <div className="gate-buttons">
            <button type="button" className="primary" disabled={busy !== undefined} onClick={() => void send(true)}>
              {busy === 'pass' ? '提交中…' : '通过'}
            </button>
            <button type="submit" disabled={busy !== undefined}>
              {busy === 'back' ? '提交中…' : '打回修改'}
            </button>
          </div>
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
