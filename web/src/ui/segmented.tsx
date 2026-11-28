import { Tabs } from '@base-ui/react/tabs'
import { cn } from './cn.ts'

/**
 * 分段切换（例如「过程 / 改动」）：浅底的外框，选中的那一段是白底加很轻的阴影。
 * 基于 Base UI 的 Tabs：键盘左右键切换，读屏软件按页签读。用法：
 * <Segmented defaultValue="log"><SegmentedList><SegmentedItem value="log">过程</SegmentedItem>…</SegmentedList><SegmentedPanel value="log">…</SegmentedPanel></Segmented>
 */
export function Segmented({ className, ...props }: Tabs.Root.Props) {
  return <Tabs.Root data-slot="segmented" className={cn('flex flex-col gap-4', className)} {...props} />
}

export function SegmentedList({ className, ...props }: Tabs.List.Props) {
  return <Tabs.List data-slot="segmented-list" className={cn('flex gap-0.5 self-start rounded-control bg-fill p-0.75', className)} {...props} />
}

export function SegmentedItem({ className, ...props }: Tabs.Tab.Props) {
  return (
    <Tabs.Tab
      data-slot="segmented-item"
      className={cn(
        'h-7 cursor-pointer rounded-md border-0 bg-transparent px-3.5 py-0 font-sans text-sm text-ink-2 outline-hidden transition duration-150 motion-reduce:transition-none hover:bg-transparent hover:text-ink',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid',
        'aria-selected:bg-surface aria-selected:font-medium aria-selected:text-ink aria-selected:shadow-segment',
        className,
      )}
      {...props}
    />
  )
}

export function SegmentedPanel({ className, ...props }: Tabs.Panel.Props) {
  return <Tabs.Panel data-slot="segmented-panel" className={cn('min-w-0 outline-hidden', className)} {...props} />
}
