import { Input as InputPrimitive } from '@base-ui/react/input'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

// 输入框、多行输入框、下拉共用的外观。font-sans：不引入 preflight 时，浏览器给表单控件用自己的字体（textarea 是等宽字体）
export const fieldControl =
  'w-full min-w-0 rounded-md border border-border bg-background px-2.5 py-1 font-sans text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20'

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <InputPrimitive type={type} data-slot="input" className={cn(fieldControl, 'h-8', className)} {...props} />
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(fieldControl, 'min-h-16 py-2', className)} {...props} />
}
