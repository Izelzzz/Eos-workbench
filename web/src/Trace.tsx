// trace 树：每行是一个 span，带缩进、展开箭头、耗时、token 和瀑布图耗时条。
import type { Span } from './api.ts'
import { duration, KIND, statusClass, tokens } from './format.ts'

export type Row = { span: Span; depth: number }

/** 按展开状态把树压平成可见的行。 */
export const visibleRows = (root: Span, open: Set<string>): Row[] => {
  const rows: Row[] = []
  const walk = (s: Span, depth: number) => {
    rows.push({ span: s, depth })
    if (open.has(s.id)) s.children.forEach(c => walk(c, depth + 1))
  }
  walk(root, 0)
  return rows
}

/** 默认展开到调用这一层；运行中或等待回答的调用连同它的步骤一起展开；没通过的检查展开到每一项。 */
export const defaultOpen = (root: Span): Set<string> => {
  const open = new Set<string>()
  const walk = (s: Span) => {
    if (s.kind === 'task' || s.kind === 'node' || (s.kind === 'call' && s.status !== 'ok') || (s.kind === 'check' && s.status === 'error')) open.add(s.id)
    s.children.forEach(walk)
  }
  walk(root)
  return open
}

const totalTokens = (s: Span) => (s.usage === undefined ? undefined : s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite)

export function TraceTree(props: {
  rows: Row[]
  open: Set<string>
  selected: string | undefined
  bounds: { start: number; end: number }
  now: number
  onToggle: (id: string) => void
  onSelect: (id: string) => void
}) {
  const { start, end } = props.bounds
  const span = end - start
  return (
    <div className="trace" role="tree">
      <div className="trace-head">
        <span>名称</span>
        <span className="num">耗时</span>
        <span className="num">tokens</span>
        <span>时间线</span>
      </div>
      {props.rows.map(({ span: s, depth }) => {
        const until = s.end ?? props.now
        const left = s.start > 0 ? ((s.start - start) / span) * 100 : 0
        const width = s.start > 0 ? Math.max(((until - s.start) / span) * 100, 0.4) : 0
        const hasChildren = s.children.length > 0
        return (
          <div
            key={s.id}
            role="treeitem"
            aria-selected={props.selected === s.id}
            aria-expanded={hasChildren ? props.open.has(s.id) : undefined}
            className={`trace-row kind-${s.kind}${props.selected === s.id ? ' selected' : ''}`}
            onClick={() => props.onSelect(s.id)}
          >
            <span className="name" style={{ paddingLeft: depth * 16 }}>
              <button
                className="caret"
                aria-label={props.open.has(s.id) ? '收起' : '展开'}
                style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
                onClick={e => {
                  e.stopPropagation()
                  props.onToggle(s.id)
                }}
              >
                {props.open.has(s.id) ? '▾' : '▸'}
              </button>
              <span className={`badge kind-${s.kind}`}>{KIND[s.kind]}</span>
              <span className={`dot ${statusClass(s.status)}`} title={s.status} />
              <span className="label">{s.name}</span>
            </span>
            <span className="num">{s.start > 0 && s.kind !== 'question' && s.kind !== 'answer' && s.kind !== 'note' ? duration(until - s.start) : ''}</span>
            <span className="num">{tokens(totalTokens(s))}</span>
            <span className="lane">
              {s.start > 0 && (
                <span className={`bar kind-${s.kind} ${statusClass(s.status)}${s.end === undefined ? ' live' : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}
