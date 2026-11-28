import type { ReactNode } from 'react'
import { Nav, navOf } from './Nav.tsx'

/** 页面外壳：宽屏时导航在左边、内容在右边；窄屏时导航在顶上。页面内容自己决定怎么排 */
export function Shell({ hash, children }: { hash: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Nav current={navOf(hash)} />
      <main className="min-w-0 flex-1 px-4 py-5 md:px-10 md:py-9">{children}</main>
    </div>
  )
}
