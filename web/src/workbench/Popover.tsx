import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../ui/index.ts'

type Props = { open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactNode; children: ReactNode; align?: 'left' | 'right' }

/** 贴着触发按钮弹出的一小块浮层：点外面或按 Esc 关闭 */
export function Popover({ open, onOpenChange, trigger, children, align = 'left' }: Props) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) onOpenChange(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open, onOpenChange])
  return (
    <div ref={root} className="relative flex max-w-full min-w-0">
      {trigger}
      {open && <div className={cn('absolute top-full z-10 mt-1 max-w-screen rounded-lg border border-border bg-popover text-popover-foreground shadow-md', align === 'right' ? 'right-0' : 'left-0')}>{children}</div>}
    </div>
  )
}
