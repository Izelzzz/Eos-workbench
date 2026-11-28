import type { ComponentProps } from 'react'
import { cn } from './cn.ts'
import { ChevronDownIcon } from './icons.tsx'
import { fieldControl } from './input.tsx'

/**
 * 下拉选择，用浏览器原生的 <select>：手机上弹出系统选择器，键盘和读屏软件都按原生方式工作。
 * 选项用 <option>；2～5 个选项、需要一眼看到全部时，考虑改用一组按钮。
 */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <div data-slot="select-wrapper" className="relative w-full min-w-0">
      <select data-slot="select" className={cn(fieldControl, 'h-8 cursor-pointer appearance-none pr-8', className)} {...props} />
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}
