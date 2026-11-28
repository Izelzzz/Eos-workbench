import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

/** 一组表单项，纵向排列 */
export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="field-group" className={cn('flex w-full flex-col gap-4', className)} {...props} />
}

/**
 * 一个表单项：标签、控件、说明、错误。
 * 校验失败时在 Field 上设 data-invalid，在控件上设 aria-invalid；禁用时在 Field 上设 data-disabled。
 */
export function Field({ className, ...props }: ComponentProps<'div'>) {
  return <div role="group" data-slot="field" className={cn('group/field flex w-full flex-col gap-1.5 data-[disabled]:opacity-50', className)} {...props} />
}

export function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn('flex w-fit items-center gap-2 text-sm leading-snug font-medium text-ink select-none group-data-[disabled]/field:pointer-events-none', className)}
      {...props}
    />
  )
}

/** 说明文字：只在选择不明显、有限制、有后果或有下一步时才写（见界面 skill 的文案规则） */
export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p data-slot="field-description" className={cn('m-0 text-xs leading-normal text-ink-2', className)} {...props} />
}

/** 错误：说清楚哪里不对、怎么改。传文字；没有错误时传 undefined、null、false 或空字符串，不渲染 */
export function FieldError({ className, children, ...props }: ComponentProps<'p'>) {
  if (children === undefined || children === null || children === false || children === '') return null
  return (
    <p role="alert" data-slot="field-error" className={cn('m-0 text-xs leading-normal text-destructive', className)} {...props}>
      {children}
    </p>
  )
}
