import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn.ts'
import { CheckIcon } from './icons.tsx'

export type Step = { key: string; label: ReactNode; state: 'done' | 'current' | 'todo' }

const pill = 'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-sm text-ink-3'
const stateClass = (state: Step['state']) => (state === 'done' ? 'text-ink-2' : state === 'current' ? 'bg-fill font-medium text-ink' : undefined)

/**
 * 步骤：一行小字，步骤之间一条短线。当前步骤是浅底的小药丸，走过的步骤前面有一个勾。
 * 传 onSelect 时每一步是按钮、可以点（例如回到上一个问题）；不传时只是文字。
 */
export function Steps({ steps, onSelect, className, ...props }: Omit<ComponentProps<'ol'>, 'onSelect'> & { steps: Step[]; onSelect?: (key: string) => void }) {
  return (
    <ol data-slot="steps" className={cn('m-0 flex list-none flex-wrap items-center gap-1 p-0 text-sm', className)} {...props}>
      {steps.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden="true" className="h-px w-3.5 bg-line" />}
          {onSelect === undefined ? (
            <span aria-current={s.state === 'current' ? 'step' : undefined} className={cn(pill, stateClass(s.state))}>
              {s.state === 'done' && <CheckIcon width={12} height={12} />}
              {s.label}
            </span>
          ) : (
            <button
              type="button"
              aria-current={s.state === 'current' ? 'step' : undefined}
              onClick={() => onSelect(s.key)}
              className={cn(
                pill,
                'cursor-pointer border-0 bg-transparent py-0 font-sans outline-hidden hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid',
                stateClass(s.state),
              )}
            >
              {s.state === 'done' && <CheckIcon width={12} height={12} />}
              {s.label}
            </button>
          )}
        </li>
      ))}
    </ol>
  )
}
