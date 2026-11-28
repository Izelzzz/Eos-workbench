import { Menu as MenuPrimitive } from '@base-ui/react/menu'
import type { ReactNode } from 'react'
import { cn } from './cn.ts'

/**
 * 浮层菜单（下拉）：白底、细边框、12px 圆角、浮层阴影；每项圆角 8px，悬停和当前项是浅底。
 * 基于 Base UI 的 Menu：键盘上下键选择、Esc 关闭、焦点回到触发按钮。
 */
export const Menu = MenuPrimitive.Root

export function MenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />
}

export function MenuContent({ className, align = 'end', children, ...props }: MenuPrimitive.Popup.Props & { align?: 'start' | 'center' | 'end' }) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner sideOffset={6} align={align} className="isolate z-50">
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn('flex max-w-sm min-w-65 flex-col gap-px rounded-box border border-line bg-surface p-1.5 text-base text-ink shadow-popover outline-hidden', className)}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/** 一项：左边可以放一个短标记（例如序号），右边可以放补充信息 */
export function MenuItem({ className, lead, trail, current, children, ...props }: MenuPrimitive.Item.Props & { lead?: ReactNode; trail?: ReactNode; current?: boolean }) {
  return (
    <MenuPrimitive.Item
      data-slot="menu-item"
      aria-current={current === true ? 'true' : undefined}
      className={cn('flex w-full cursor-pointer items-baseline gap-2.5 rounded-lg px-2.5 py-2 text-left outline-hidden data-highlighted:bg-fill aria-current:bg-fill', className)}
      {...props}
    >
      {lead !== undefined && <span className="w-7 flex-none text-xs text-ink-3">{lead}</span>}
      <span className="min-w-0 flex-1">{children}</span>
      {trail !== undefined && <span className="ml-auto flex-none text-xs text-ink-3">{trail}</span>}
    </MenuPrimitive.Item>
  )
}

export function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="menu-separator" className={cn('mx-1 my-1.25 h-px bg-line', className)} {...props} />
}
