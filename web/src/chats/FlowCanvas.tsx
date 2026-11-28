import { Badge, Button, cn } from '../ui/index.ts'
import { isChanged } from './ChatCards.tsx'
import { ArrowLeftIcon } from './icons.tsx'
import type { WorkflowChange } from './mock.ts'

// 画板上节点的位置是数据，不是样式：每行 4 个，从左到右、从上到下
const W = 184
const H = 68
const GX = 64
const GY = 84
const PER_ROW = 4
const PAD = 48
const at = (i: number) => ({ x: PAD + (i % PER_ROW) * (W + GX), y: PAD + 28 + Math.floor(i / PER_ROW) * (H + GY) })

/**
 * 画板（示意）：装得下很长、带回头环节的流程。
 * 正式的画板是以后的功能（拖动、缩放、直接在上面改）；这里只画出节点和连线，区域可以上下左右滚动。
 */
export function FlowCanvas({ change, onBack }: { change: WorkflowChange; onBack: () => void }) {
  const stages = change.stages
  const rows = Math.ceil(stages.length / PER_ROW)
  const width = PAD * 2 + PER_ROW * W + (PER_ROW - 1) * GX
  const height = PAD * 2 + 28 + rows * H + (rows - 1) * GY
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <header className="flex flex-none flex-wrap items-center justify-between gap-2 px-4 py-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon />
          回到对话
        </Button>
        <span className="text-sm text-ink-3">
          {change.name} · {stages.length} 个阶段，改了 {stages.filter(isChanged).length} 个
        </span>
      </header>
      <div className="chat-canvas relative min-h-0 flex-1 overflow-auto border-t border-line bg-bg">
        <div className="relative" style={{ width, height }}>
          <svg aria-hidden="true" width={width} height={height} className="absolute inset-0 text-ink-3" fill="none" stroke="currentColor" strokeWidth={1.2}>
            {stages.slice(0, -1).map((s, i) => {
              const a = at(i)
              const b = at(i + 1)
              // 同一行：一条横线；换行：从右边下来，绕到下一行的开头
              const d =
                a.y === b.y
                  ? `M${a.x + W} ${a.y + H / 2} H${b.x}`
                  : `M${a.x + W} ${a.y + H / 2} h${GX / 2} v${(H + GY) / 2} H${b.x - GX / 2} v${(H + GY) / 2} h${GX / 2}`
              return <path key={s.stage} d={d} />
            })}
            {stages.map((s, i) => {
              if (s.back === undefined) return null
              const from = at(i)
              const to = at(stages.findIndex(x => x.stage === s.back))
              const top = Math.min(from.y, to.y) - 30
              // 正上方就是目标时直接连上去；否则从上面绕过去
              const d = from.x === to.x ? `M${from.x + W / 2} ${from.y} V${to.y + H}` : `M${from.x + W / 2} ${from.y} V${top} H${to.x + W / 2} V${to.y}`
              return <path key={`back-${s.stage}`} strokeDasharray="4 4" d={d} />
            })}
          </svg>
          {stages.map((s, i) => {
            const p = at(i)
            return (
              <div
                key={s.stage}
                style={{ left: p.x, top: p.y, width: W, height: H }}
                className={cn(
                  'absolute flex flex-col justify-center rounded-box bg-surface px-3.5 shadow-card',
                  s.change === 'removed' && 'bg-transparent shadow-none',
                  isChanged(s) && s.change !== 'removed' && 'shadow-selected',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={cn('truncate font-medium', !isChanged(s) && 'font-normal text-ink-2', s.change === 'removed' && 'text-ink-3 line-through')}>{s.stage}</span>
                  {isChanged(s) && <Badge variant="neutral">{s.change === 'added' ? '新增' : s.change === 'removed' ? '删除' : '修改'}</Badge>}
                </span>
                {isChanged(s) && s.change === undefined && <span className="truncate text-xs text-ink-3">{s.summary}</span>}
              </div>
            )
          })}
          {stages.map((s, i) => {
            if (s.back === undefined) return null
            const from = at(i)
            const to = at(stages.findIndex(x => x.stage === s.back))
            return (
              <span key={`label-${s.stage}`} className="absolute bg-bg px-1.5 text-xs text-ink-3" style={from.x === to.x ? { left: from.x + W / 2 + 10, top: (from.y + to.y + H) / 2 - 9 } : { left: (from.x + to.x) / 2 + W / 2 - 24, top: Math.min(from.y, to.y) - 39 }}>
                不通过
              </span>
            )
          })}
        </div>
      </div>
      <p className="m-0 flex-none border-t border-line px-5 py-2.5 text-sm text-ink-3">示意：正式的画板可以拖动、缩放，并且直接在上面改流程。这是以后的功能。</p>
    </div>
  )
}
