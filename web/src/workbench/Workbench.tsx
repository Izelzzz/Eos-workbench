import type { ReactNode } from 'react'
import type { Workbench as Data } from '../api.ts'
import { ActiveTasks } from './ActiveTasks.tsx'
import { PendingList } from './PendingList.tsx'

/**
 * 工作台上有哪几块、放在哪一栏、什么顺序，只在这里定。每一块是独立的组件，互相不引用。
 * 这一版不开放给用户调整。
 */
type SectionId = 'pending' | 'active'
const LAYOUT: { main: SectionId[]; side: SectionId[] } = { main: ['pending'], side: ['active'] }

/** 工作台：宽屏左边是「等你处理」、右边一栏是「进行中的任务」；窄屏上下排 */
export function Workbench({ data, error }: { data: Data | undefined; error: string | undefined }) {
  const sections: Record<SectionId, (d: Data) => ReactNode> = {
    pending: d => <PendingList key="pending" items={d.pending} />,
    active: d => <ActiveTasks key="active" tasks={d.active} total={d.activeTotal} />,
  }
  if (data === undefined) return <p className="m-0 px-4 py-5 text-ink-2 md:px-10 md:py-9">{error === undefined ? '加载中…' : `连接不上服务：${error}（自动重试中）`}</p>
  return (
    <div className="flex flex-col lg:min-h-screen lg:flex-row">
      <div className="flex min-w-0 flex-col lg:flex-1">
        <div className="mx-auto flex w-full max-w-195 flex-col gap-11 px-4 pt-5 pb-8 md:px-10 md:pt-9">
          {error !== undefined && (
            <p role="alert" className="m-0 text-sm text-destructive">
              连接不上服务：{error}（每 5 秒自动重试）
            </p>
          )}
          {LAYOUT.main.map(id => sections[id](data))}
        </div>
      </div>
      <aside className="flex min-w-0 flex-col gap-11 border-t border-line px-4 pt-6 pb-8 md:px-10 lg:max-w-150 lg:shrink lg:grow-1 lg:basis-115 lg:border-t-0 lg:border-l lg:px-8 lg:pt-9">
        {LAYOUT.side.map(id => sections[id](data))}
      </aside>
    </div>
  )
}
