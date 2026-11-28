import type { ComponentProps, ReactNode } from 'react'

// 对话页用到的图标，画法同 shell/icons.tsx
const make = (children: ReactNode) =>
  function Icon(props: ComponentProps<'svg'>) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {children}
      </svg>
    )
  }

export const PlusIcon = make(
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
)
export const ArrowUpIcon = make(
  <>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </>,
)
export const ArrowLeftIcon = make(
  <>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </>,
)
export const MoreIcon = make(
  <>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </>,
)
