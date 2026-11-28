import type { ComponentProps } from 'react'
import { cn } from './cn.ts'
import { ChevronDownIcon } from './icons.tsx'
import { fieldControl } from './input.tsx'

/**
 * 下拉选择，用浏览器原生的 <select>：手机上弹出系统选择器，键盘和读屏软件都按原生方式工作。
 * 选项用 <option>；2～5 个选项、需要一眼看到全部时，考虑改用一组按钮。
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  // className 用在外层：宽度、外边距这类布局类要作用在包着图标的那一层
  return (
    <div data-slot="select-wrapper" className={cn('relative w-full min-w-0', className)}>
      <select data-slot="select" className={cn(fieldControl, 'h-8 cursor-pointer appearance-none pr-8')} {...props} />
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}
