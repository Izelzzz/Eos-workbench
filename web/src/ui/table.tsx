import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

/** 表格。外层可以横向滚动：窄屏下宽表格在自己的框里滚，不撑宽整个页面 */
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto rounded-lg border border-border bg-card">
      <table data-slot="table" className={cn('w-full border-collapse text-sm', className)} {...props} />
    </div>
  )
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>) {
  return <thead data-slot="table-header" className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr data-slot="table-row" className={cn('border-b border-border hover:bg-muted data-[state=selected]:bg-accent', className)} {...props} />
}

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th data-slot="table-head" className={cn('h-9 px-3 text-left align-middle text-code font-semibold whitespace-nowrap text-muted-foreground', className)} {...props} />
}

/** 数字列加 tabular-nums 并右对齐 */
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td data-slot="table-cell" className={cn('px-3 py-2 align-middle', className)} {...props} />
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-3 caption-bottom text-sm text-muted-foreground', className)} {...props} />
}
