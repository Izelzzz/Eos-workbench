import { Input as InputPrimitive } from '@base-ui/react/input'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

// 输入框、多行输入框、下拉共用的外观：细边框，聚焦时边框变成墨色。
// font-sans：不引入 preflight 时，浏览器给表单控件用自己的字体（textarea 是等宽字体）。
// 窄屏用 16px 字：iOS Safari 在字号小于 16px 的输入框获得焦点时会放大页面
export const fieldControl =
  'w-full min-w-0 rounded-control border border-line bg-surface px-3 py-1 font-sans text-lg text-ink outline-none transition duration-150 motion-reduce:transition-none placeholder:text-ink-3 focus-visible:border-ink disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive sm:text-base'

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <InputPrimitive type={type} data-slot="input" className={cn(fieldControl, 'h-9', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(fieldControl, 'min-h-20 py-2.5', className)} {...props} />
}
