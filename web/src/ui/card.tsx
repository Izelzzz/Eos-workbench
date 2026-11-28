import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

/** 一块面板。标题、正文、底部操作各用对应的部件，不把所有内容塞进 CardContent */
export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section data-slot="card" className={cn('flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card py-3 text-card-foreground', className)} {...props} />
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('flex flex-col gap-1 px-4', className)} {...props} />
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 data-slot="card-title" className={cn('m-0 text-md leading-snug font-semibold', className)} {...props} />
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="card-description" className={cn('m-0 text-sm text-muted-foreground', className)} {...props} />
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('min-w-0 px-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex flex-wrap items-center gap-2 px-4', className)} {...props} />
}
