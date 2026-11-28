import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

/**
 * 卡片：没有边框，靠阴影浮起来。一屏只有一张当前要处理的卡片用它，其余内容平铺在背景上（见界面 skill 的「长什么样」）。
 * 标题、正文、底部操作各用对应的部件，不把所有内容塞进 CardContent。
 */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('flex min-w-0 flex-col gap-4 rounded-card bg-surface p-5.5 pb-4.5 text-ink shadow-card sm:p-7 sm:pb-5.5', className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1.5', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('m-0 text-title leading-tight font-semibold tracking-title text-ink', className)} {...props} />
}

/** 引导语：一两句说清楚要你做什么 */
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('m-0 max-w-lead text-lead text-ink-2', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('min-w-0', className)} {...props} />
}

/** 底部操作：靠右，主操作放最右边 */
export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex flex-wrap items-center justify-end gap-2 pt-2', className)} {...props} />
}
