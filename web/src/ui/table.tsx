import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

/** 表格：没有外框，行与行之间一条细线。外层可以横向滚动：窄屏下宽表格在自己的框里滚，不撑宽整个页面 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn('w-full border-collapse text-base', className)} {...props} />
    </div>
  )
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b [&_tr]:border-line', className)} {...props} />
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('border-b border-line transition duration-150 motion-reduce:transition-none hover:bg-fill data-[state=selected]:bg-fill-2', className)} {...props} />
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th data-slot="table-head" className={cn('h-9 px-3 text-left align-middle text-sm font-medium whitespace-nowrap text-ink-2', className)} {...props} />
}

/** 数字列加 tabular-nums 并右对齐 */
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('h-11 px-3 align-middle', className)} {...props} />
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-3 caption-bottom text-sm text-ink-3', className)} {...props} />
}
