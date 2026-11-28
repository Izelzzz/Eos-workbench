import { useEffect, useRef, useState } from 'react'
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Textarea } from '../ui/index.ts'
import { ChevronDownIcon } from '../ui/icons.tsx'
import { TaskDraftCard, WorkflowChangeCard } from './ChatCards.tsx'
import { ArrowUpIcon, PlusIcon } from './icons.tsx'
import type { Conversation as Chat, Message, WorkflowChange } from './mock.ts'

type Props = {
  chat: Chat | undefined
  recent: Chat[]
  onOpen: (id: string) => void
  onNew: () => void
  onAll: () => void
  onSend: (text: string) => void
  /** 让代理人把某张修改卡片重新提一版 */
  onRevise: (text: string, of: WorkflowChange) => void
  onCanvas: (of: WorkflowChange) => void
  waiting: boolean
}

/** 一个对话：只有这一个对话，居中。输入框一直在底部，发送前后位置不变 */
export function Conversation({ chat, recent, onOpen, onNew, onAll, onSend, onRevise, onCanvas, waiting }: Props) {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [chat?.id, chat?.messages.length, waiting])
  const send = () => {
    const said = text.trim()
    if (said === '' || waiting) return
    setText('')
    onSend(said)
  }
  return (
    <div className="mx-auto flex min-h-0 w-full flex-1 flex-col md:w-3/5">
      <header className="flex min-w-0 flex-none items-center justify-between gap-2 px-4 py-3">
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="sm" className="min-w-0 text-base font-semibold text-ink" />}>
            <span className="min-w-0 truncate">{chat?.title ?? '新对话'}</span>
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuContent align="start">
            {recent.map(c => (
              <MenuItem key={c.id} current={c.id === chat?.id} trail={c.when} onClick={() => onOpen(c.id)}>
                {c.title}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={onAll} className="text-ink-2">
              全部对话
            </MenuItem>
          </MenuContent>
        </Menu>
        {chat !== undefined && (
          <Button variant="ghost" size="sm" onClick={onNew}>
            <PlusIcon />
            新对话
          </Button>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
        <span className="flex-1" />
        {chat === undefined ? (
          <section className="flex flex-col gap-1 pb-4">
            <h1 className="m-0 mb-4 text-title leading-snug font-semibold">要做什么？</h1>
            <h2 className="m-0 mb-1 text-sm font-medium text-ink-2">最近的对话</h2>
            <ul className="m-0 flex list-none flex-col p-0">
              {recent.slice(0, 4).map(c => (
                <li key={c.id} className="border-t border-line last:border-b">
                  <Button variant="ghost" onClick={() => onOpen(c.id)} className="h-11 w-full justify-between gap-4 rounded-control px-0 font-normal hover:bg-transparent">
                    <span className="min-w-0 truncate font-medium text-ink">{c.title}</span>
                    <span className="flex-none text-sm text-ink-3">{c.when}</span>
                  </Button>
                </li>
              ))}
            </ul>
            <Button variant="link" className="mt-2 self-start px-0 text-ink-2" onClick={onAll}>
              全部对话
            </Button>
          </section>
        ) : (
          // key 带上对话的 id：切换对话时卡片重新开始，不沿用上一个对话里卡片的状态
          chat.messages.map((m, i) => <Bubble key={`${chat.id}-${i}`} message={m} onRevise={onRevise} onCanvas={onCanvas} />)
        )}
        {waiting && <p className="m-0 text-ink-3">正在回复…</p>}
        <div ref={end} />
      </div>

      <div className="mx-4 mb-4 flex flex-none flex-col gap-1 rounded-input border border-line bg-surface p-3 focus-within:border-ink-3">
        <label htmlFor="chat-say" className="sr-only">
          对代理人说
        </label>
        <Textarea
          id="chat-say"
          rows={2}
          placeholder="提需求、问进展、改工作流"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
          className="min-h-11 resize-none border-0 bg-transparent px-1 py-0 shadow-none focus-visible:outline-none"
        />
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm">
            eos-workbench
            <ChevronDownIcon />
          </Button>
          <Button size="icon" aria-label="发送" disabled={waiting || text.trim() === ''} onClick={send} className="rounded-full">
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

function Bubble({ message, onRevise, onCanvas }: { message: Message; onRevise: Props['onRevise']; onCanvas: Props['onCanvas'] }) {
  if (message.from === 'me') return <p className="m-0 max-w-full self-end rounded-input rounded-br-sm bg-fill px-3.5 py-2 wrap-anywhere">{message.text}</p>
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <p className="m-0 wrap-anywhere">{message.text}</p>
      {message.card?.kind === 'task' && <TaskDraftCard draft={message.card} />}
      {message.card?.kind === 'workflow' && <WorkflowChangeCard change={message.card} onRevise={text => onRevise(text, message.card as WorkflowChange)} onCanvas={() => onCanvas(message.card as WorkflowChange)} />}
    </div>
  )
}
