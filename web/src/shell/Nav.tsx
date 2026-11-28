import type { ComponentType, ComponentProps } from 'react'
import { AccentDot, cn } from '../ui/index.ts'
import { ChatIcon, ConventionsIcon, ImproveIcon, InsightsIcon, SettingsIcon, TasksIcon, WorkbenchIcon } from './icons.tsx'

export type NavId = 'workbench' | 'chats' | 'tasks' | 'insights' | 'improve' | 'conventions' | 'settings'
export type NavItem = { id: NavId; label: string; icon: ComponentType<ComponentProps<'svg'>> }

/** 导航里有哪几项、按什么顺序，只在这里定。上面一组是日常用的页面，下面一组固定在左下角 */
export const NAV_MAIN: NavItem[] = [
  { id: 'workbench', label: '工作台', icon: WorkbenchIcon },
  { id: 'chats', label: '对话', icon: ChatIcon },
  { id: 'tasks', label: '任务', icon: TasksIcon },
  { id: 'insights', label: '统计', icon: InsightsIcon },
  { id: 'improve', label: '改进', icon: ImproveIcon },
  { id: 'conventions', label: '团队约定', icon: ConventionsIcon },
]
export const NAV_FOOT: NavItem[] = [{ id: 'settings', label: '设置', icon: SettingsIcon }]

type Props = {
  current: NavId
  /** 等你处理的件数：大于 0 时「工作台」的图标右上角有一个强调色的小圆点 */
  waiting?: number
  hrefOf: (id: NavId) => string
  onNavigate?: (id: NavId, e: React.MouseEvent) => void
}

/**
 * 主导航：宽屏是左边一条窄的图标栏，鼠标移上去或键盘聚焦时显示名字；窄屏是顶上一行。
 * 不依赖页面上的其他部分。
 */
export function Nav({ current, waiting = 0, hrefOf, onNavigate }: Props) {
  const link = (item: NavItem) => {
    const Icon = item.icon
    const dot = item.id === 'workbench' && waiting > 0
    return (
      <a
        key={item.id}
        href={hrefOf(item.id)}
        aria-label={dot ? `${item.label}，${waiting} 件等你处理` : item.label}
        aria-current={item.id === current ? 'page' : undefined}
        onClick={e => onNavigate?.(item.id, e)}
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
    <nav aria-label="主导航" className="flex flex-none items-center gap-0.5 px-4 py-2 md:w-14 md:flex-col md:px-0 md:py-3.5">
      <span aria-hidden="true" className="mr-2.5 flex size-7 flex-none items-center justify-center rounded-lg bg-ink text-sm font-semibold text-surface md:mr-0 md:mb-3.5">
        E
      </span>
      {NAV_MAIN.map(link)}
      <span className="flex-1" />
      {NAV_FOOT.map(link)}
    </nav>
  )
}
