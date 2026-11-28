import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import type { ComponentProps } from 'react'
import { Button } from './button.tsx'
import { cn } from './cn.ts'
import { XIcon } from './icons.tsx'

/**
 * 对话框。用于需要确认的操作（删除、覆盖、放宽权限）和不离开当前页面就能完成的小表单。
 * 一定要有 DialogTitle；不想显示标题时给它 className="sr-only"。
 */
export function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

export function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

export function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

export function DialogContent({ className, children, showCloseButton = true, ...props }: DialogPrimitive.Popup.Props & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className="fixed inset-0 isolate z-50 bg-overlay" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          'fixed inset-x-4 top-1/2 z-50 mx-auto grid max-h-full max-w-sm -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-card bg-surface p-6 text-base text-ink shadow-popover outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" aria-label="关闭" render={<Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" />}>
            <XIcon />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-header" className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />
}

/** 底部按钮：窄屏竖排（主操作在上），宽屏横排靠右 */
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-footer" className={cn('flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end', className)} {...props} />
}

export function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn('m-0 text-md leading-snug font-semibold text-ink', className)} {...props} />
}

export function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn('m-0 text-control text-ink-2', className)} {...props} />
}
