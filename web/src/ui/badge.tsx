import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from './cn.ts'

export const badgeVariants = cva('inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap', {
  variants: {
    variant: {
      // 普通的小标签（例如选项旁的「推荐」）
      neutral: 'bg-fill text-ink-2',
      // 只用于「等你处理」
      accent: 'bg-accent-soft text-accent',
      outline: 'border border-line text-ink-2',
      // 状态用实色，和现有页面的状态标签一致。设计稿还没定状态色，重做页面时再改
      running: 'rounded-full bg-running px-2 text-on-solid',
      success: 'rounded-full bg-success px-2 text-on-solid',
      warning: 'rounded-full bg-warning px-2 text-on-solid',
      destructive: 'rounded-full bg-destructive px-2 text-on-solid',
      pending: 'rounded-full bg-pending px-2 text-on-solid',
    },
  },
  defaultVariants: { variant: 'neutral' },
})

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>

/** 短标签：状态、类型、计数。只放几个字，不放句子 */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}
