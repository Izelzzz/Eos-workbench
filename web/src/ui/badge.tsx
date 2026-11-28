import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

// 状态用实色：和任务列表里现有的状态标签一致（进行中、成功、等待、失败、未开始）
export const badgeVariants = cva('inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full border border-transparent px-2 text-xs font-semibold whitespace-nowrap', {
  variants: {
    variant: {
      running: 'bg-primary text-primary-foreground',
      success: 'bg-success text-primary-foreground',
      warning: 'bg-warning text-primary-foreground',
      destructive: 'bg-destructive text-primary-foreground',
      pending: 'bg-pending text-primary-foreground',
      secondary: 'bg-secondary text-secondary-foreground',
      outline: 'border-border text-muted-foreground',
    },
  },
  defaultVariants: { variant: 'secondary' },
})

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

/** 短标签：状态、类型、计数。只放几个字，不放句子 */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}
