import type { ComponentProps } from 'react'

// 组件内部用的几个图标。画法和 Lucide 一致（24 格、2px 描边、颜色跟随文字），不另装图标库
const Icon = ({ children, ...props }: ComponentProps<'svg'>) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
)

export const XIcon = (props: ComponentProps<'svg'>) => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
)

export const ChevronDownIcon = (props: ComponentProps<'svg'>) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)

export const CheckIcon = (props: ComponentProps<'svg'>) => (
  <Icon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
)
