import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn.ts'

/** 信息行列表（例如改动、测试、评审）：左边 56px 宽的灰色标签，右边是值，行与行之间一条细线 */
export function InfoList({ className, ...props }: ComponentProps<'dl'>) {
  return <dl data-slot="info-list" className={cn('m-0 flex flex-col border-b border-line', className)} {...props} />
}

export function InfoRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div data-slot="info-row" className={cn('flex gap-5 border-t border-line py-2.75', className)}>
      <dt className="w-14 flex-none text-ink-3">{label}</dt>
      <dd className="m-0 min-w-0 wrap-anywhere text-ink">{children}</dd>
    </div>
  )
}

/** 说明块：浅底、12px 圆角，放一两句补充说明。里面要强调的词用 <b>，显示成墨色 */
export function Note({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="note" className={cn('rounded-box bg-fill px-3.5 py-3 text-control text-ink-2 [&_b]:font-medium [&_b]:text-ink', className)} {...props} />
}

/** 强调色的小圆点：只表示「等你处理」 */
export function AccentDot({ className }: { className?: string }) {
  return <span aria-hidden="true" data-slot="waiting-dot" className={cn('inline-block size-1.5 flex-none rounded-full bg-accent', className)} />
}
