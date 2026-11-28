import type { WorkbenchTask } from '../api.ts'
import { ChevronRightIcon, TaskList, TaskRow } from '../ui/index.ts'
import { SectionHead } from './SectionHead.tsx'

/** 进行中的任务：每个一行（最多 10 个，等你处理的在前），点了打开任务详情；「全部」到任务列表 */
export function ActiveTasks({ tasks, total }: { tasks: WorkbenchTask[]; total: number }) {
  return (
    <section aria-labelledby="wb-active">
      <SectionHead
        id="wb-active"
        title="进行中的任务"
        count={total}
        action={
          <a href="#/tasks" className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-ink-2 no-underline hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink focus-visible:outline-solid">
            全部
            <ChevronRightIcon width={14} height={14} />
          </a>
        }
      />
      {tasks.length === 0 ? (
        <p className="m-0 text-sm text-ink-3">没有进行中的任务。</p>
      ) : (
        <TaskList>
          {tasks.map(t => (
            <TaskRow key={t.id} name={t.title || t.id} state={t.state} total={t.total} done={t.done} waiting={t.waiting !== undefined} onSelect={() => (location.hash = `#/tasks/${t.id}`)} />
          ))}
        </TaskList>
      )}
    </section>
  )
}
