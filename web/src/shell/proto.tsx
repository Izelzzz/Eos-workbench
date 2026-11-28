// 导航的原型：只有导航是真的，右边每一页都是占位。不是正式页面
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Segmented, SegmentedItem, SegmentedList, SegmentedPanel } from '../ui/index.ts'
import '../index.css'
import './proto.css'
import { NAV_FOOT, NAV_MAIN, Nav, type NavId } from './Nav.tsx'

const Blank = ({ children }: { children: string }) => <p className="m-0 rounded-card border border-dashed border-line px-5 py-9 text-center text-ink-3">{children}</p>

function Proto() {
  const [page, setPage] = useState<NavId>('workbench')
  const [waiting, setWaiting] = useState(3)
  const label = [...NAV_MAIN, ...NAV_FOOT].find(n => n.id === page)!.label
  return (
    <div className="flex min-h-screen flex-col bg-bg font-sans text-base text-ink md:h-screen md:flex-row">
      <Nav
        current={page}
        waiting={waiting}
        hrefOf={id => `#${id}`}
        onNavigate={(id, e) => {
          e.preventDefault()
          setPage(id)
        }}
      />
      <main className="flex min-w-0 flex-1 flex-col gap-6 px-4 py-5 md:overflow-y-auto md:px-10 md:py-9">
        <h1 className="m-0 text-sm font-medium text-ink-2">{label}</h1>
        {page === 'settings' ? (
          <Segmented defaultValue="credentials">
            <SegmentedList>
              <SegmentedItem value="credentials">凭据</SegmentedItem>
              <SegmentedItem value="forges">代码托管</SegmentedItem>
            </SegmentedList>
            <SegmentedPanel value="credentials">
              <Blank>现在的「凭据」页搬到这里。</Blank>
            </SegmentedPanel>
            <SegmentedPanel value="forges">
              <Blank>现在的「代码托管」页搬到这里。</Blank>
            </SegmentedPanel>
          </Segmented>
        ) : (
          <Blank>{`「${label}」页的位置。这一版原型只看导航。`}</Blank>
        )}
        <p className="m-0 flex flex-wrap items-center gap-3 text-sm text-ink-3">
          演示用：
          <Button variant="outline" size="sm" onClick={() => setWaiting(waiting > 0 ? 0 : 3)}>
            {waiting > 0 ? '改成没有等你处理的事' : '改成有 3 件等你处理'}
          </Button>
        </p>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Proto />
  </StrictMode>,
)
