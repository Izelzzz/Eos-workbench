import { useState, type ReactNode } from 'react'
import { Button, cn } from '../ui/index.ts'
import { ChatPanel, freshChat } from './ChatPanel.tsx'
import { BookIcon, ChartIcon, DashboardIcon, MessageIcon, PanelOpenIcon, SlidersIcon, TasksIcon, TrendIcon } from './icons.tsx'
import { initialPending, initialTasks, type Conversation, type PendingItem, type Task } from './mock.ts'
import { Pending } from './Pending.tsx'
import { TaskPane } from './TaskPane.tsx'
import { Tasks } from './Tasks.tsx'

/**
 * 工作台上有哪几块、按什么顺序放，只在这里定。
 * 每一块是一个独立的组件，互相不引用；以后要调整顺序或者让用户自己排，改这个数组就行。
 */
type SectionId = 'pending' | 'tasks'
const MAIN_SECTIONS: SectionId[] = ['pending', 'tasks']

const NAV = [
  { label: '工作台', href: '#/', icon: DashboardIcon, current: true },
  { label: '对话', href: '#/chats', icon: MessageIcon },
  { label: '任务', href: '#/tasks', icon: TasksIcon },
  { label: '统计', href: '#/insights', icon: ChartIcon },
  { label: '改进', href: '#/improve', icon: TrendIcon },
]
const NAV_BOTTOM = [
  { label: '团队约定', href: '#/conventions', icon: BookIcon },
  { label: '设置', href: '#/settings', icon: SlidersIcon },
]

export function Workbench() {
  const [pending, setPending] = useState<PendingItem[]>(initialPending)
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [flash, setFlash] = useState<string>()
  const [pane, setPane] = useState<{ taskId: string; tab: 'process' | 'diff' }>()
  const [chatOpen, setChatOpen] = useState(true)
  const [focused, setFocused] = useState(false)
  const [chat, setChat] = useState<Conversation>(freshChat)
  const chatProps = { chat, onChat: setChat, onFocus: setFocused, onCollapse: () => setChatOpen(false), pendingCount: pending.length }

  const resolve = (item: PendingItem) => {
    setPending(p => p.filter(x => x.id !== item.id))
    if (item.taskId === undefined) return
    setTasks(ts => ts.map(t => (t.id === item.taskId ? { ...t, waiting: false, status: item.resolved, done: item.kind === 'accept' ? 4 : t.done } : t)))
    setFlash(item.taskId)
    setTimeout(() => setFlash(undefined), 1000)
  }
  const openTask = (taskId: string, tab: 'process' | 'diff') => setPane({ taskId, tab })
  const paneTask = pane === undefined ? undefined : tasks.find(t => t.id === pane.taskId)

  const sections: Record<SectionId, ReactNode> = {
    pending: <Pending key="pending" items={pending} onResolve={resolve} onOpenTask={openTask} />,
    tasks: <Tasks key="tasks" tasks={tasks} flash={flash} onOpenTask={openTask} />,
  }

  return (
    <div className="flex min-h-screen bg-background font-sans text-base text-foreground">
      <nav aria-label="主导航" className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border bg-card py-3">
        <span className="pb-2 text-md font-bold">Eos</span>
        {NAV.map(n => (
          <NavLink key={n.label} {...n} current={focused ? n.label === '对话' : n.current} />
        ))}
        <span className="flex-1" />
        {NAV_BOTTOM.map(n => (
          <NavLink key={n.label} {...n} />
        ))}
      </nav>

      {focused ? (
        <main className="flex h-screen min-w-0 flex-1 flex-col bg-card">
          <ChatPanel focused {...chatProps} />
        </main>
      ) : (
        <main className="flex min-w-0 flex-1 flex-col md:h-screen md:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-8 p-4 md:overflow-y-auto md:p-8">
            <div className="flex w-full min-w-0 flex-col gap-8">{MAIN_SECTIONS.map(id => sections[id])}</div>
          </div>

          {paneTask !== undefined && pane !== undefined ? (
            <aside className="flex min-h-96 w-full shrink-0 flex-col border-t border-border bg-card md:w-md md:border-t-0 md:border-l">
              <TaskPane task={paneTask} tab={pane.tab} onTab={tab => setPane({ ...pane, tab })} onClose={() => setPane(undefined)} />
            </aside>
          ) : chatOpen ? (
            <aside className="flex min-h-96 w-full shrink-0 flex-col border-t border-border bg-card md:w-sm md:border-t-0 md:border-l">
              <ChatPanel focused={false} {...chatProps} />
            </aside>
          ) : (
            <aside className="flex shrink-0 items-start justify-center border-t border-border bg-card p-2 md:border-t-0 md:border-l">
              <Button variant="ghost" size="icon" aria-label="展开对话" title="展开对话" onClick={() => setChatOpen(true)}>
                <PanelOpenIcon />
              </Button>
            </aside>
          )}
        </main>
      )}
    </div>
  )
}

function NavLink({ label, href, icon: Icon, current }: { label: string; href: string; icon: typeof DashboardIcon; current?: boolean }) {
  return (
    <a
      href={href}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex w-14 flex-col items-center gap-1 rounded-md py-2 text-2xs text-muted-foreground no-underline outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
        current && 'bg-accent font-semibold text-foreground',
      )}
    >
      <Icon width={18} height={18} />
      {label}
    </a>
  )
}
