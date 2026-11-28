import { useState } from 'react'
import { Badge, Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Textarea, cn } from '../ui/index.ts'
import { ChevronDownIcon } from '../ui/icons.tsx'
import { ArrowLeftIcon, MaximizeIcon, PanelCloseIcon, PlusIcon } from './icons.tsx'
import { conversations, type ChatMessage, type Conversation } from './mock.ts'
import { Popover } from './Popover.tsx'

type Props = {
  /** 放大：只显示这一个对话 */
  focused: boolean
  onFocus: (focused: boolean) => void
  onCollapse: () => void
  /** 放大时右上角显示的待处理件数 */
  pendingCount: number
  /** 当前的对话。放在外面保存：放大、收起再展开时不丢 */
  chat: Conversation
  onChat: (update: (chat: Conversation) => Conversation) => void
}

export const freshChat = (): Conversation => ({ id: `new-${Date.now()}`, title: '新对话', when: '', messages: [] })

/** 对话：和代理人说话。输入框只属于这里。不依赖页面上的其他部分 */
export function ChatPanel({ focused, onFocus, onCollapse, pendingCount, chat, onChat }: Props) {
  const [text, setText] = useState('')
  const [menu, setMenu] = useState(false)
  const [waiting, setWaiting] = useState(false)

  const send = () => {
    const said = text.trim()
    if (said === '' || waiting) return
    const title = chat.messages.length === 0 ? said.slice(0, 16) : chat.title
    onChat(c => ({ ...c, title, messages: [...c.messages, { from: 'me', text: said }] }))
    setText('')
    setWaiting(true)
    // 原型：代理人的回复是写死的
    setTimeout(() => {
      setWaiting(false)
      onChat(c => ({
        ...c,
        messages: [...c.messages, { from: 'agent', text: '我按这个需求准备了一个任务。', draft: { title: said.slice(0, 16), repo: 'eos-workbench', workflow: 'standard', need: said } }],
      }))
    }, 700)
  }

  return (
    <section aria-label="对话" className={cn('flex min-h-0 min-w-0 flex-1 flex-col', focused && 'mx-auto w-full md:w-2/3')}>
      <header className="flex min-w-0 items-center justify-between gap-1 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-1">
          {focused && (
            <Button variant="ghost" onClick={() => onFocus(false)}>
              <ArrowLeftIcon />
              回工作台
              {pendingCount > 0 && <Badge variant="warning">{pendingCount}</Badge>}
            </Button>
          )}
          <Popover
            open={menu}
            onOpenChange={setMenu}
            trigger={
              <Button variant="ghost" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} className="min-w-0 text-md font-semibold">
                <span className="min-w-0 truncate">{chat.title}</span>
                <ChevronDownIcon />
              </Button>
            }
          >
            <ul role="menu" aria-label="切换对话" className="m-0 flex w-72 max-w-full list-none flex-col gap-0.5 p-1">
              {conversations.map(c => (
                <li key={c.id} role="none">
                  <Button
                    role="menuitem"
                    variant="ghost"
                    className={cn('h-auto w-full justify-between gap-3 py-2 text-left font-normal whitespace-normal', c.id === chat.id && 'bg-accent')}
                    onClick={() => {
                      onChat(() => c)
                      setMenu(false)
                    }}
                  >
                    <span className="min-w-0 flex-1">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{c.when}</span>
                  </Button>
                </li>
              ))}
              <li role="none" className="border-t border-border pt-1">
                <a role="menuitem" href="#/chats" className="flex h-8 items-center rounded-md px-3 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50">
                  全部对话
                </a>
              </li>
            </ul>
          </Popover>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" aria-label="新对话" title="新对话" onClick={() => onChat(freshChat)}>
            <PlusIcon />
          </Button>
          {!focused && (
            <>
              <Button variant="ghost" size="icon" aria-label="放大对话" title="放大" onClick={() => onFocus(true)}>
                <MaximizeIcon />
              </Button>
              <Button variant="ghost" size="icon" aria-label="收起对话" title="收起" onClick={onCollapse}>
                <PanelCloseIcon />
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 overflow-y-auto p-4">
        {chat.messages.length === 0 && <p className="m-0 text-center text-sm text-muted-foreground">说一句需求，问一个任务的进展，或者让它改工作流。</p>}
        {chat.messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
        {waiting && <p className="m-0 text-sm text-muted-foreground">正在回复…</p>}
      </div>

      <div className="flex flex-col gap-2 border-t border-border p-3">
        <label htmlFor="wb-say" className="sr-only">
          对代理人说
        </label>
        <Textarea
          id="wb-say"
          rows={2}
          placeholder="提需求、问进展、改工作流"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <Button variant="outline" size="sm">
            eos-workbench
            <ChevronDownIcon />
          </Button>
          <Button onClick={send} disabled={waiting || text.trim() === ''}>
            发送
          </Button>
        </div>
      </div>
    </section>
  )
}

function Message({ message }: { message: ChatMessage }) {
  if (message.from === 'me') return <p className="m-0 max-w-full self-end rounded-lg bg-accent px-3 py-2 wrap-anywhere">{message.text}</p>
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 wrap-anywhere">{message.text}</p>
      {message.draft !== undefined && <Draft draft={message.draft} />}
    </div>
  )
}

function Draft({ draft }: { draft: NonNullable<ChatMessage['draft']> }) {
  const [state, setState] = useState<'pending' | 'created' | 'dropped'>('pending')
  return (
    <Card>
      <CardHeader>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="min-w-0 truncate">新任务：{draft.title}</CardTitle>
          <Badge variant={state === 'created' ? 'success' : state === 'dropped' ? 'outline' : 'warning'}>{state === 'created' ? '已创建' : state === 'dropped' ? '没有创建' : '待确认'}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="m-0 flex flex-col gap-1">
          {(
            [
              ['仓库', draft.repo],
              ['工作流', draft.workflow],
              ['需求', draft.need],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-12 shrink-0 text-muted-foreground">{k}</dt>
              <dd className="m-0 min-w-0 flex-1 wrap-anywhere">{v}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
      {state === 'pending' && (
        <CardFooter className="justify-end">
          <Button variant="outline" onClick={() => setState('dropped')}>
            不创建
          </Button>
          <Button onClick={() => setState('created')}>创建任务</Button>
        </CardFooter>
      )}
    </Card>
  )
}
