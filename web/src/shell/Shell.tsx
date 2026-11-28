import type { ReactNode } from 'react'
import { Nav, navOf } from './Nav.tsx'

/**
 * 页面外壳：宽屏时导航在左边、内容在右边；窄屏时导航在顶上。页面内容自己决定怎么排。
 * waiting：等你处理的件数（导航「工作台」上的小圆点）；bleed：内容贴边，由页面自己留边距（工作台的右栏要通到底）
 */
export function Shell({ hash, waiting, bleed = false, children }: { hash: string; waiting: number; bleed?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Nav current={navOf(hash)} waiting={waiting} />
      <main className={bleed ? 'min-w-0 flex-1' : 'min-w-0 flex-1 px-4 py-5 md:px-10 md:py-9'}>{children}</main>
    </div>
  )
}
