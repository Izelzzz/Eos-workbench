import { Credentials } from '../Credentials.tsx'
import { ForgeApps } from '../ForgeApps.tsx'
import { Segmented, SegmentedItem, SegmentedList, SegmentedPanel } from '../ui/index.ts'

export type SettingsTab = 'credentials' | 'forges'

/** #/credentials、#/forges（可带 ?查询）是设置页两段的地址；别的地址不是设置页 */
export const parseSettingsRoute = (hash: string): { tab: SettingsTab; query: string } | undefined => {
  const m = /^#\/(credentials|forges)(?:\?(.*))?$/.exec(hash)
  return m === null ? undefined : { tab: m[1] as SettingsTab, query: m[2] ?? '' }
}

/** 设置：凭据和代码托管用分段切换分开，切换时地址跟着变，旧链接直接打开对应的一段 */
export function Settings({ tab, query }: { tab: SettingsTab; query: string }) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="m-0 text-sm font-medium text-ink-2">设置</h1>
      <Segmented value={tab} onValueChange={v => (location.hash = `#/${v as SettingsTab}`)}>
        <SegmentedList>
          <SegmentedItem value="credentials">凭据</SegmentedItem>
          <SegmentedItem value="forges">代码托管</SegmentedItem>
        </SegmentedList>
        <SegmentedPanel value="credentials">
          <Credentials />
        </SegmentedPanel>
        <SegmentedPanel value="forges">
          <ForgeApps query={query} />
        </SegmentedPanel>
      </Segmented>
    </div>
  )
}
