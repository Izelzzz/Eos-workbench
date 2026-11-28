import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn.ts'
import { AccentDot } from './info.tsx'

/** 任务清单：行与行之间一条细线，和清单同宽；鼠标移到能点的一行上时，这一行上下的线隐去 */
export function TaskList({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="task-list"
      className={cn('m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-line [&>li:has(button:hover)]:border-transparent [&>li:has(button:hover)+li]:border-transparent', className)}
      {...props}
    />
  )
}

export type TaskRowProps = {
  name: ReactNode
  /** 状态文字，例如「测试 · 第 2 轮」「规格 · 等你回答」 */
  state: ReactNode
  /** 进度：一共几段（工作流的节点数）、已走完几段（超出范围按边界算）。正在走的是下一段 */
  total: number
  done: number
  /** 等人处理：名字前有强调色圆点，正在走的那一段和状态文字用强调色 */
  waiting?: boolean
  /** 点了打开任务详情；不传时这一行只是文字 */
  onSelect?: () => void
  className?: string
}

/** 一行任务：左边任务名，中间一小段一小段的进度，右边状态（148px 宽，右对齐）。窄屏下不显示进度；读屏读「进度 几 / 几」 */
export function TaskRow({ name, state, total, done, waiting = false, onSelect, className }: TaskRowProps) {
  const segments = Number.isFinite(total) ? Math.max(1, Math.trunc(total)) : 1
  const reached = Number.isFinite(done) ? Math.max(0, Math.min(segments, Math.trunc(done))) : 0
  const steps = Array.from({ length: segments }, (_, i) => (i < reached ? 'done' : i === reached ? 'current' : 'todo'))
  const body = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
        {waiting && <AccentDot />}
        <span className="truncate">{name}</span>
      </span>
      <span className="sr-only">
        ，进度 {reached} / {segments}
      </span>
      <span aria-hidden="true" className="hidden flex-none gap-0.75 sm:flex">
        {steps.map((s, i) => (
          <i key={i} className={cn('h-0.75 w-3.5 rounded-2xs bg-fill-2', s === 'done' && 'bg-ink', s === 'current' && (waiting ? 'bg-accent' : 'bg-ink-3'))} />
        ))}
      </span>
      <span className={cn('w-auto max-w-1/2 flex-none truncate text-right text-sm text-ink-3 sm:w-37 sm:max-w-none', waiting && 'text-accent')}>{state}</span>
    </>
  )
  const row = 'flex h-11 w-full items-center gap-4 rounded-control px-3 text-left font-sans text-base text-ink'
  return (
    <li data-slot="task-row" data-waiting={waiting || undefined}>
      {/* 行比清单左右各宽 12px（悬停的底色），分隔线在 li 上，和清单同宽 */}
      <div className="-mx-3">
        {onSelect === undefined ? (
          <div className={cn(row, className)}>{body}</div>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            className={cn(
              row,
              'cursor-pointer border-0 bg-transparent py-0 outline-hidden transition duration-150 motion-reduce:transition-none hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid',
              className,
            )}
          >
            {body}
          </button>
        )}
      </div>
    </li>
  )
}
