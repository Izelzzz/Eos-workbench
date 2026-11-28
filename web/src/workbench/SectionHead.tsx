import type { ReactNode } from 'react'
import { AccentDot } from '../ui/index.ts'

/** 区块标题：小号灰字，后面是件数；有等你处理的事时前面有强调色圆点。右边可以放一个操作 */
export function SectionHead({ id, title, count, dot = false, action }: { id: string; title: string; count: number; dot?: boolean; action?: ReactNode }) {
  return (
    <div className="mb-3.5 flex min-h-8 items-center justify-between gap-3">
      <h2 id={id} className="m-0 flex items-center gap-2 text-sm font-medium text-ink-2">
        {dot && <AccentDot />}
        {title}
        <span className="font-normal text-ink-3 tabular-nums">{count}</span>
      </h2>
      {action}
    </div>
  )
}
