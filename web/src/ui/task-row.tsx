import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn.ts'
import { AccentDot } from './info.tsx'

/** 任务清单：行与行之间一条细线 */
export function TaskList({ className, ...props }: ComponentProps<'ul'>) {
  return <ul data-slot="task-list" className={cn('m-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-line', className)} {...props} />
}

export type TaskRowProps = {
  name: ReactNode
  /** 状态文字，例如「测试 · 第 2 轮」「规格 · 等你回答」 */
  state: ReactNode
  /** 五小段进度：已走完几段（0～5）。正在走的是下一段 */
  done: number
  /** 等人处理：名字前有强调色圆点，正在走的那一段和状态文字用强调色 */
  waiting?: boolean
  onSelect?: () => void
  className?: string
}

const SEGMENTS = 5

/** 一行任务：左边任务名，中间五小段进度，右边状态（148px 宽，右对齐）。窄屏下不显示进度 */
export function TaskRow({ name, state, done, waiting = false, onSelect, className }: TaskRowProps) {
  const steps = Array.from({ length: SEGMENTS }, (_, i) => (i < done ? 'done' : i === done ? 'current' : 'todo'))
  return (
    <li data-slot="task-row" data-waiting={waiting || undefined} className="-mx-3">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex h-11 w-full cursor-pointer items-center gap-4 rounded-control border-0 bg-transparent px-3 py-0 text-left font-sans text-base text-ink',
          'outline-hidden transition duration-150 motion-reduce:transition-none hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid',
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 font-medium">
          {waiting && <AccentDot />}
          <span className="truncate">{name}</span>
        </span>
        <span aria-hidden="true" className="hidden flex-none gap-0.75 sm:flex">
          {steps.map((s, i) => (
            <i key={i} className={cn('h-0.75 w-3.5 rounded-2xs bg-fill-2', s === 'done' && 'bg-ink', s === 'current' && (waiting ? 'bg-accent' : 'bg-ink-3'))} />
          ))}
        </span>
        <span className={cn('w-auto max-w-1/2 flex-none truncate text-right text-sm text-ink-3 sm:w-37 sm:max-w-none', waiting && 'text-accent')}>{state}</span>
      </button>
    </li>
  )
}
