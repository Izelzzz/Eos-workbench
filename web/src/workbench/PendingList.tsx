import type { WorkbenchItem } from '../api.ts'
import { SectionHead } from './SectionHead.tsx'

const KIND: Record<WorkbenchItem['kind'], string> = { question: '提问', gate: '验收', proposal: '提案' }
const hrefOf = (i: WorkbenchItem) => (i.kind === 'proposal' ? `#/improve/${i.id}` : `#/tasks/${i.taskId}`)
const titleOf = (i: WorkbenchItem) => (i.kind === 'proposal' ? `${i.target.name}：${i.rationale.split('\n')[0]}` : i.title || i.taskId)

/**
 * 等你处理：现在每件事一行，链到处理它的页面。
 * 下一步（工作台 D）换成一件一张卡片、在工作台上直接处理。
 */
export function PendingList({ items }: { items: WorkbenchItem[] }) {
  return (
    <section aria-labelledby="wb-pending">
      <SectionHead id="wb-pending" title="等你处理" count={items.length} dot={items.length > 0} />
      {items.length === 0 ? (
        <p className="m-0 rounded-card border border-dashed border-line px-5 py-9 text-center text-ink-3">现在没有等你处理的事。</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {items.map(i => (
            <li key={i.kind === 'proposal' ? `p${i.id}` : `${i.kind}-${i.taskId}`} className="border-line [&+li]:border-t">
              <a
                href={hrefOf(i)}
                className="-mx-3 flex min-h-11 items-center gap-3 rounded-control px-3 py-2 text-ink no-underline hover:bg-fill focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid"
              >
                <span className="flex-none text-sm text-accent">{KIND[i.kind]}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{titleOf(i)}</span>
                {i.kind !== 'proposal' && <span className="flex-none text-sm text-ink-3">{i.repo}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
