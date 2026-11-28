import type { ComponentType, ComponentProps } from 'react'
import { AccentDot, cn } from '../ui/index.ts'
import { ChatIcon, ConventionsIcon, ImproveIcon, InsightsIcon, SettingsIcon, TasksIcon, WorkbenchIcon } from './icons.tsx'

export type NavId = 'workbench' | 'chats' | 'tasks' | 'insights' | 'improve' | 'conventions' | 'settings'
export type NavItem = { id: NavId; label: string; href: string; icon: ComponentType<ComponentProps<'svg'>> }

/**
 * 导航里有哪几项、按什么顺序，只在这里定。上面一组是日常用的页面，下面一组固定在左下角。
 */
export const NAV_MAIN: NavItem[] = [
  { id: 'workbench', label: '工作台', href: '#/', icon: WorkbenchIcon },
  { id: 'chats', label: '对话', href: '#/chat', icon: ChatIcon },
  { id: 'tasks', label: '任务', href: '#/tasks', icon: TasksIcon },
  { id: 'insights', label: '统计', href: '#/insights', icon: InsightsIcon },
  { id: 'improve', label: '改进', href: '#/improve', icon: ImproveIcon },
  { id: 'conventions', label: '团队约定', href: '#/conventions', icon: ConventionsIcon },
]
export const NAV_FOOT: NavItem[] = [{ id: 'settings', label: '设置', href: '#/credentials', icon: SettingsIcon }]

/** 地址（location.hash）对应导航里的哪一项：按第一段路径查表，查不到的（首页和不认识的地址）算「工作台」 */
const SECTION: Record<string, NavId> = {
  tasks: 'tasks',
  new: 'tasks',
  chat: 'chats',
  insights: 'insights',
  improve: 'improve',
  conventions: 'conventions',
  credentials: 'settings',
  forges: 'settings',
}
export const navOf = (hash: string): NavId => SECTION[/^#\/([\w-]+)/.exec(hash)?.[1] ?? ''] ?? 'workbench'

type Props = {
  current: NavId
  /** 等你处理的件数：大于 0 时「工作台」的图标右上角有一个强调色的小圆点 */
  waiting?: number
}

/**
 * 主导航：宽屏是左边一条窄的图标栏，鼠标移上去或键盘聚焦时显示名字；窄屏是顶上一行。
 * 不依赖页面上的其他部分。
 */
export function Nav({ current, waiting = 0 }: Props) {
  const link = (item: NavItem) => {
    const Icon = item.icon
    const dot = item.id === 'workbench' && waiting > 0
    return (
      <a
        key={item.id}
        href={item.href}
        aria-label={dot ? `${item.label}，${waiting} 件等你处理` : item.label}
        aria-current={item.id === current ? 'page' : undefined}
        className={cn(
          'group relative flex size-10 flex-none items-center justify-center rounded-control text-ink-3 no-underline transition-colors duration-150 hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid motion-reduce:transition-none',
          item.id === current && 'bg-fill-2 text-ink hover:bg-fill-2',
        )}
      >
        <Icon />
        {dot && <AccentDot className="absolute top-2 right-2" />}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-full z-20 ml-2 rounded-md bg-ink px-2 py-0.5 text-xs whitespace-nowrap text-surface opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 max-md:hidden motion-reduce:transition-none"
        >
          {item.label}
        </span>
      </a>
    )
  }
  return (
    <nav aria-label="主导航" className="flex flex-none items-center gap-0.5 px-4 py-2 md:sticky md:top-0 md:z-10 md:h-screen md:w-14 md:flex-col md:px-0 md:py-3.5">
      <span aria-hidden="true" className="mr-2.5 flex size-7 flex-none items-center justify-center rounded-lg bg-ink text-sm font-semibold text-surface md:mr-0 md:mb-3.5">
        E
      </span>
      {NAV_MAIN.map(link)}
      <span className="flex-1" />
      {NAV_FOOT.map(link)}
    </nav>
  )
}
