import { Badge, Button, cn } from '../ui/index.ts'
import { XIcon } from '../ui/icons.tsx'
import { MaximizeIcon } from './icons.tsx'
import { STAGES, paneFiles, paneProcess, type Task } from './mock.ts'

type Props = { task: Task; tab: 'process' | 'diff'; onTab: (tab: 'process' | 'diff') => void; onClose: () => void }

/** 任务详情的分栏：在工作台里看一个任务，不离开工作台 */
export function TaskPane({ task, tab, onTab, onClose }: Props) {
  return (
    <section aria-label="任务详情" className="wb-enter flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <h2 className="m-0 min-w-0 truncate text-md font-semibold">{task.title}</h2>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" aria-label="放大成整页" title="放大成整页">
            <MaximizeIcon />
          </Button>
          <Button variant="ghost" size="icon" aria-label="关闭任务详情" title="关闭" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant={task.waiting ? 'warning' : 'running'}>{task.waiting ? '等你处理' : '进行中'}</Badge>
          {task.repo} · {task.id}
        </p>
        <ol className="m-0 grid list-none grid-cols-5 gap-1 p-0">
          {STAGES.map((s, i) => (
            <li key={s} className={cn('rounded-md border border-border px-1 py-1 text-center text-sm text-muted-foreground', i < task.done && 'bg-muted', i === task.done && 'border-primary font-semibold text-foreground')}>
              {s}
            </li>
          ))}
        </ol>
        <div role="tablist" aria-label="任务详情的内容" className="flex gap-1 border-b border-border">
          {(
            [
              ['process', '过程'],
              ['diff', '改动'],
            ] as const
          ).map(([id, label]) => (
            <Button key={id} role="tab" aria-selected={tab === id} variant="ghost" onClick={() => onTab(id)} className={cn('-mb-px rounded-none border-0 border-b-2 border-transparent px-3 text-muted-foreground', tab === id && 'border-primary text-foreground')}>
              {label}
            </Button>
          ))}
        </div>
        {tab === 'process' ? (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {paneProcess.map(p => (
              <li key={p.when} className="rounded-md border border-border px-3 py-2">
                <p className="m-0 text-xs text-muted-foreground">
                  {p.who} · {p.when}
                </p>
                <p className="m-0 wrap-anywhere">{p.text}</p>
              </li>
            ))}
          </ol>
        ) : (
          <ul className="m-0 flex list-none flex-col rounded-md border border-border p-0">
            {paneFiles.map(([file, change], i) => (
              <li key={file} className={cn('flex items-baseline justify-between gap-3 px-3 py-2', i > 0 && 'border-t border-border')}>
                <code className="min-w-0 font-mono text-code wrap-anywhere">{file}</code>
                <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{change}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
