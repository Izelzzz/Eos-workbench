import { Button, cn } from '../ui/index.ts'
import { STAGES, type Task } from './mock.ts'

type Props = {
  tasks: Task[]
  /** 最多显示几个；其余的在任务列表页 */
  limit?: number
  /** 刚刚因为处理了待办而变化的任务：闪一下 */
  flash?: string
  onOpenTask: (taskId: string, tab: 'process' | 'diff') => void
}

/** 进行中的任务：每个任务两行（标题和进度在同一行，下面是阶段条）。不依赖页面上的其他部分 */
export function Tasks({ tasks, limit = 10, flash, onOpenTask }: Props) {
  const shown = tasks.slice(0, limit)
  return (
    <section aria-labelledby="wb-tasks" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="wb-tasks" className="m-0 text-lg font-semibold">
          进行中的任务 <span className="font-normal text-muted-foreground tabular-nums">{tasks.length}</span>
        </h2>
        {tasks.length > shown.length && (
          <a href="#/tasks" className="rounded-sm text-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
            全部 {tasks.length} 个
          </a>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">没有进行中的任务。在右边的对话里说一句需求，开始第一个。</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map(t => (
            <li key={t.id}>
              <Button variant="ghost" onClick={() => onOpenTask(t.id, 'process')} className={cn('h-auto w-full flex-col items-stretch gap-1.5 px-3 py-2 text-left font-normal', flash === t.id && 'wb-flash')}>
                <span className="flex min-w-0 items-baseline justify-between gap-4">
                  <span className="min-w-0 truncate text-base font-medium">{t.title}</span>
                  <span className={cn('shrink-0 text-sm text-muted-foreground', t.waiting && 'font-medium text-warning')}>{t.status}</span>
                </span>
                <span className="flex gap-1" role="img" aria-label={`共 ${STAGES.length} 个阶段，完成了 ${t.done} 个`}>
                  {STAGES.map((s, i) => (
                    <span key={s} className={cn('h-1 flex-1 rounded-full bg-border', i < t.done && 'bg-primary', i === t.done && (t.waiting ? 'bg-warning' : 'bg-primary/40'))} />
                  ))}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
