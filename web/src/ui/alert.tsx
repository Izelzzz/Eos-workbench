import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

export const alertVariants = cva('relative grid w-full gap-0.5 rounded-lg border px-3 py-2 text-left text-sm', {
  variants: {
    variant: {
      default: 'border-border bg-card text-card-foreground',
      success: 'border-success/40 bg-success/10 text-foreground',
      warning: 'border-warning/45 bg-warning/12 text-foreground',
      destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
    },
  },
  defaultVariants: { variant: 'default' },
})

export type AlertProps = ComponentProps<'div'> & VariantProps<typeof alertVariants>

/**
 * 提示块：操作结果、需要注意的限制、失败原因。
 * 失败（destructive）用 role="alert" 让读屏软件立即读出；其余用 role="status"。
 */
export function Alert({ className, variant, role, ...props }: AlertProps) {
  return <div data-slot="alert" role={role ?? (variant === 'destructive' ? 'alert' : 'status')} className={cn(alertVariants({ variant }), className)} {...props} />
}

export function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('font-semibold', className)} {...props} />
}

export function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-description" className={cn('text-sm wrap-anywhere whitespace-pre-wrap', className)} {...props} />
}
