// 对话页：和对话 agent 聊工作流设计。agent 能读平台的工作流、约定和任务，能提议工作流和 Agent 模板；提议要人在这里看过差异、点「保存」才生效。
import { useEffect, useRef, useState } from 'react'
import type { ChatMessage, ChatStreamLine, ChatSummary, ChatView, ProposalView } from './api.ts'
import { getChat, listChats, saveChatProposal, sendChat } from './api.ts'
import { Diff } from './Conventions.tsx'
import { ago, tokens } from './format.ts'

/** #/chat 是对话列表和新建，#/chat/<id> 是一个对话。 */
export const parseChatRoute = (hash: string): { id?: string } | undefined => {
  if (hash === '#/chat') return {}
  const m = /^#\/chat\/(c[0-9a-z]+)$/.exec(hash)
  return m === null ? undefined : { id: m[1]! }
}

const KIND = { workflow: '工作流', template: 'Agent 模板' } as const

/** 工具名 → 人看得懂的说法。 */
const TOOL_NAMES: Record<string, string> = {
  list_conventions: '约定列表',
  get_convention: '约定',
  convention_history: '约定的历史版本',
  list_tasks: '任务列表',
  get_task: '任务',
  get_task_trace: '任务的 trace',
  get_task_metrics: '任务的用量',
  get_task_changes: '任务的改动',
  propose_convention: '提议',
}

/** 工具参数（JSON）→ 简短的说明：只取值，例如「workflow / standard」。 */
const argsText = (args: string): string => {
  try {
    const v = JSON.parse(args) as Record<string, unknown>
    return Object.entries(v)
      .filter(([k]) => k !== 'content' && k !== 'rationale')
      .map(([, x]) => String(x))
      .join(' / ')
  } catch {
    return ''
  }
}

function Reads(props: { reads: { tool: string; args: string; isError: boolean }[] }) {
  if (props.reads.length === 0) return null
  return (
    <ul className="chat-reads" aria-label="读了哪些数据">
      {props.reads.map((r, i) => (
        <li key={i} className={r.isError ? 'error' : ''}>
          {r.tool === 'propose_convention' ? '提议' : `读了${TOOL_NAMES[r.tool] ?? r.tool}`}
          {argsText(r.args) === '' ? '' : `：${argsText(r.args)}`}
          {r.isError ? '（出错）' : ''}
        </li>
      ))}
    </ul>
  )
}

function Message(props: { m: ChatMessage }) {
  const m = props.m
  if (m.role === 'user')
    return (
      <div className="chat-msg user">
        <div className="chat-meta">你 · {ago(m.at)}</div>
        <div className="chat-text">{m.text}</div>
      </div>
    )
  if (m.role === 'error')
    return (
      <div className="chat-msg failed" role="alert">
        <div className="chat-meta">没有回复 · {ago(m.at)}</div>
        <div className="chat-text">{m.text}</div>
      </div>
    )
  return (
    <div className="chat-msg assistant">
      <div className="chat-meta">
        助手 · {ago(m.at)} · {(m.call.ms / 1000).toFixed(1)}s · {tokens(m.call.usage.input + m.call.usage.output)} tokens
      </div>
      <Reads reads={m.call.reads} />
      <div className="chat-text">{m.text}</div>
    </div>
  )
}

/** 正在进行的这一轮：用户刚说的话，和 agent 到现在为止读了什么、写了什么。 */
type Live = { text: string; reads: { id: string; tool: string; args: string; isError: boolean }[]; steps: string[] }

function LiveTurn(props: { live: Live }) {
  return (
    <>
      <div className="chat-msg user">
        <div className="chat-meta">你 · 刚刚</div>
        <div className="chat-text">{props.live.text}</div>
      </div>
      <div className="chat-msg assistant live" aria-live="polite">
        <div className="chat-meta">助手 · 正在回复…</div>
        <Reads reads={props.live.reads} />
        {props.live.steps.map((s, i) => (
          <div key={i} className="chat-text">
            {s}
          </div>
        ))}
      </div>
    </>
  )
}

const STATE: Record<ProposalView['state'], { label: string; cls: string }> = {
  pending: { label: '待确认', cls: 'waiting' },
  unanswered: { label: '这一轮还没结束', cls: 'running' },
  stale: { label: '已过期', cls: 'error' },
  voided: { label: '已作废', cls: 'error' },
  saved: { label: '已保存', cls: 'ok' },
}

function Proposal(props: { v: ProposalView; onSaved: () => void }) {
  const { v } = props
  const p = v.proposal
  const [allow, setAllow] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const needsAllow = v.code !== undefined
  const save = async () => {
    setBusy(true)
    setError(undefined)
    const r = await saveChatProposal(p.id, { ...(needsAllow ? { confirm: v.code } : {}), ...(note.trim() === '' ? {} : { note }) })
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      // 权限改动在看过之后变了：刷新，让人看新的清单再确认。
      if ('code' in r && r.code !== undefined) props.onSaved()
      return
    }
    props.onSaved()
  }
  return (
    <section className="chat-proposal" aria-label={`提议 #${p.id}`}>
      <div className="chat-proposal-head">
        <strong>
          #{p.id} {KIND[p.kind]}「{p.name}」
        </strong>
        <span className="muted">{p.baseVersion === undefined ? '新建' : `修改第 ${p.baseVersion} 版`}</span>
        <span className={`pill ${STATE[v.state].cls}`}>{STATE[v.state].label}</span>
      </div>
      <p className="chat-rationale">{p.rationale}</p>
      {v.state === 'saved' && (
        <p className="muted">
          已保存为第 {p.saved!.version} 版（{p.saved!.actor}，{ago(p.saved!.at)}）
        </p>
      )}
      {v.state === 'voided' && <p className="error">{p.voided}</p>}
      {v.state === 'unanswered' && <p className="muted">这一轮还没有回复（还在进行，或者没做完），现在不能保存。</p>}
      {v.state === 'stale' && (
        <p className="error">
          「{p.name}」现在是第 {v.current?.version ?? '?'} 版，这条提议基于的版本已经过期，保存会被拒绝：请让 agent 基于现在的版本重新提议。
        </p>
      )}
      {(v.state === 'pending' || v.state === 'stale') && (
        <>
          {v.permissions.length > 0 && (
            <div className="chat-permissions" role="alert">
              <strong>⚠ 涉及权限改动（按现在的平台状态算）</strong>
              <ul>
                {v.permissions.map(x => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted">{v.current === undefined ? '全文（新建）' : `和当前第 ${v.current.version} 版的差异`}</p>
          <Diff before={v.current?.content ?? ''} after={p.content} />
        </>
      )}
      {v.state === 'pending' && (
        <div className="chat-save">
          {needsAllow && (
            <label className="chat-allow">
              <input type="checkbox" checked={allow} onChange={e => setAllow(e.target.checked)} />
              我看过上面的权限改动，确认要这样改（确认码 <code>{v.code}</code>）
            </label>
          )}
          <input className="chat-note" placeholder="备注（可选）" value={note} onChange={e => setNote(e.target.value)} />
          <button type="button" className="primary" disabled={busy || (needsAllow && !allow)} onClick={save}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function Composer(props: { chat?: string; onDone: (chat?: string) => void; onLive: (live: Live | undefined) => void; disabled?: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const send = async () => {
    const said = text.trim()
    if (said === '') return
    setBusy(true)
    setError(undefined)
    let live: Live = { text: said, reads: [], steps: [] }
    props.onLive(live)
    const on = (line: ChatStreamLine) => {
      if (line.type === 'read') live = { ...live, reads: [...live.reads, { id: line.id, tool: line.tool, args: line.args, isError: false }] }
      else if (line.type === 'read_failed') live = { ...live, reads: live.reads.map(r => (r.id === line.id ? { ...r, isError: true } : r)) }
      else if (line.type === 'text') live = { ...live, steps: [...live.steps, line.text] }
      props.onLive(live)
    }
    const r = await sendChat({ ...(props.chat === undefined ? {} : { chat: props.chat }), text: said }, on)
    setBusy(false)
    props.onLive(undefined)
    if (r.ok) setText('')
    else setError(r.error)
    props.onDone(r.chat)
  }
  return (
    <div className="chat-composer">
      <textarea
        value={text}
        rows={3}
        placeholder={props.chat === undefined ? '想设计什么样的工作流？例如：帮我设计一个只有写规格和评审两步的工作流' : '接着说…'}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
        }}
        disabled={busy || props.disabled}
      />
      <div className="chat-composer-foot">
        <span className="muted">agent 只能读平台数据、提议修改；提议要你在这里看过、点「保存」才生效。</span>
        <button type="button" className="primary" disabled={busy || props.disabled || text.trim() === ''} onClick={send}>
          {busy ? '回复中…' : '发送'}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function ChatList() {
  const [chats, setChats] = useState<ChatSummary[]>()
  const [error, setError] = useState<string>()
  const [live, setLive] = useState<Live>()
  useEffect(() => {
    listChats().then(setChats, e => setError(String(e.message)))
  }, [])
  return (
    <div className="chat-page">
      <div className="list-head">
        <h1>对话</h1>
      </div>
      <p className="muted">和对话 agent 聊工作流设计：它能读平台上的工作流、约定和任务，按你的要求提议新的或修改过的工作流、Agent 模板。</p>
      {live !== undefined && <LiveTurn live={live} />}
      <Composer
        onLive={setLive}
        onDone={chat => {
          if (chat !== undefined) location.hash = `#/chat/${chat}`
        }}
      />
      {error && <p className="error">{error}</p>}
      {chats !== undefined && chats.length > 0 && (
        <>
          <h2 className="chat-h2">历史对话</h2>
          <ul className="chat-list">
            {chats.map(c => (
              <li key={c.id}>
                <a href={`#/chat/${c.id}`}>{c.title}</a>
                <span className="muted">
                  {c.messages} 条 · {ago(c.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {chats !== undefined && chats.length === 0 && <p className="muted">还没有对话。</p>}
    </div>
  )
}

function Conversation(props: { id: string }) {
  const [view, setView] = useState<ChatView>()
  const [error, setError] = useState<string>()
  const [live, setLive] = useState<Live>()
  const [reload, setReload] = useState(0)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    getChat(props.id).then(
      v => {
        setView(v)
        setError(undefined)
      },
      e => setError(String(e.message)),
    )
  }, [props.id, reload])
  useEffect(() => end.current?.scrollIntoView?.({ block: 'end' }), [live, view?.log.length])
  if (view === undefined) return error ? <p className="error">{error}</p> : <p className="muted">加载中…</p>
  return (
    <div className="chat-page">
      <p className="muted">
        <a href="#/chat">← 所有对话</a>
      </p>
      <h1 className="chat-title">{view.title}</h1>
      <div className="chat-log">
        {view.log.map(m => (
          <Message key={m.seq} m={m} />
        ))}
        {live !== undefined && <LiveTurn live={live} />}
      </div>
      {view.proposals.length > 0 && (
        <>
          <h2 className="chat-h2">提议（agent 提的，你点「保存」之后才生效）</h2>
          {view.proposals.map(v => (
            <Proposal key={v.proposal.id} v={v} onSaved={() => setReload(n => n + 1)} />
          ))}
        </>
      )}
      <Composer chat={props.id} onLive={setLive} onDone={() => setReload(n => n + 1)} />
      <p className="muted chat-usage">
        {view.metrics.calls} 次调用（{view.metrics.failed} 次没有回复）· 读数据 {view.metrics.reads} 次 · {tokens(view.metrics.usage.input + view.metrics.usage.output)} tokens
      </p>
      <div ref={end} />
    </div>
  )
}

export function Chat(props: { route: { id?: string } }) {
  return props.route.id === undefined ? <ChatList /> : <Conversation key={props.route.id} id={props.route.id} />
}
