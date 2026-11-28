import type { ComponentProps, ReactNode } from 'react'

// 工作台用到的图标。画法和 ui/icons.tsx 一致（Lucide：24 格、2px 描边、颜色跟随文字）
const make = (children: ReactNode) =>
  function Icon(props: ComponentProps<'svg'>) {
    return (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
        {children}
      </svg>
    )
  }

export const DashboardIcon = make(
  <>
    <rect x="3" y="3" width="7" height="9" rx="1" />
    <rect x="14" y="3" width="7" height="5" rx="1" />
    <rect x="14" y="12" width="7" height="9" rx="1" />
    <rect x="3" y="16" width="7" height="5" rx="1" />
  </>,
)
export const MessageIcon = make(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />)
export const TasksIcon = make(
  <>
    <path d="m3 17 2 2 4-4" />
    <path d="m3 7 2 2 4-4" />
    <path d="M13 6h8" />
    <path d="M13 12h8" />
    <path d="M13 18h8" />
  </>,
)
export const ChartIcon = make(
  <>
    <path d="M3 3v18h18" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </>,
)
export const TrendIcon = make(
  <>
    <path d="M22 7 13.5 15.5 8.5 10.5 2 17" />
    <path d="M16 7h6v6" />
  </>,
)
export const BookIcon = make(
  <>
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </>,
)
export const SlidersIcon = make(
  <>
    <path d="M21 4h-7" />
    <path d="M10 4H3" />
    <path d="M21 12h-9" />
    <path d="M8 12H3" />
    <path d="M21 20h-5" />
    <path d="M12 20H3" />
    <path d="M14 2v4" />
    <path d="M8 10v4" />
    <path d="M16 18v4" />
  </>,
)
export const ChevronLeftIcon = make(<path d="m15 18-6-6 6-6" />)
export const ChevronRightIcon = make(<path d="m9 18 6-6-6-6" />)
export const MaximizeIcon = make(
  <>
    <path d="M15 3h6v6" />
    <path d="M9 21H3v-6" />
    <path d="m21 3-7 7" />
    <path d="m3 21 7-7" />
  </>,
)
export const PlusIcon = make(
  <>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>,
)
export const PanelCloseIcon = make(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
    <path d="m8 9 3 3-3 3" />
  </>,
)
export const PanelOpenIcon = make(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
    <path d="m10 15-3-3 3-3" />
  </>,
)
export const ArrowLeftIcon = make(
  <>
    <path d="m12 19-7-7 7-7" />
    <path d="M19 12H5" />
  </>,
)
