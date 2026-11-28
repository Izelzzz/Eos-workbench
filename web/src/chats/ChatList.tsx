import { useState } from 'react'
import { Button, Input, Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/index.ts'
import { ArrowLeftIcon, MoreIcon, PlusIcon } from './icons.tsx'
import type { Conversation } from './mock.ts'

type Props = { chats: Conversation[]; onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void; onBack: () => void }

/** 全部对话：搜索、接着说、删除。每个对话下面写它办成了什么 */
export function ChatList({ chats, onOpen, onNew, onDelete, onBack }: Props) {
  const [q, setQ] = useState('')
  const shown = chats.filter(c => q.trim() === '' || c.title.includes(q.trim()) || c.outcome.includes(q.trim()))
  const groups = [...new Set(shown.map(c => c.group))]
  return (
    <div className="mx-auto flex min-h-0 w-full flex-1 flex-col gap-5 overflow-y-auto px-5 py-3 md:w-3/5">
      <header className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2.5">
          <ArrowLeftIcon />
          回到对话
        </Button>
        <Button size="sm" onClick={onNew}>
          <PlusIcon />
          新对话
        </Button>
      </header>
      <h1 className="m-0 text-title leading-snug font-semibold">全部对话</h1>
      <div>
        <label htmlFor="chat-q" className="sr-only">
          搜索对话
        </label>
        <Input id="chat-q" type="search" placeholder="搜索对话" value={q} onChange={e => setQ(e.target.value)} />
      </div>
      {shown.length === 0 && <p className="m-0 rounded-card border border-dashed border-line px-5 py-9 text-center text-ink-3">没有找到「{q.trim()}」。换一个词试试。</p>}
      {groups.map(g => (
        <section key={g} className="flex flex-col">
          <h2 className="m-0 mb-1 text-sm font-medium text-ink-2">{g}</h2>
          <ul className="m-0 flex list-none flex-col p-0">
            {shown
              .filter(c => c.group === g)
              .map(c => (
                <li key={c.id} className="flex items-center gap-1 border-t border-line last:border-b">
                  <Button variant="ghost" onClick={() => onOpen(c.id)} className="h-auto min-w-0 flex-1 items-center justify-between gap-4 rounded-control px-0 py-2.5 text-left font-normal hover:bg-transparent">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium text-ink">{c.title}</span>
                      <span className="truncate text-sm text-ink-3">{c.outcome}</span>
                    </span>
                    <span className="flex-none text-sm text-ink-3">{c.when}</span>
                  </Button>
                  <Menu>
                    <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={`「${c.title}」的更多操作`} />}>
                      <MoreIcon />
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem onClick={() => onDelete(c.id)} className="text-destructive">
                        删除对话
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
