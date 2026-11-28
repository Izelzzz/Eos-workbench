import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Badge, Button, cn } from '../ui/index.ts'
import { isChanged } from './ChatCards.tsx'
import { ArrowLeftIcon } from './icons.tsx'
import type { StageChange, WorkflowChange } from './mock.ts'

// 节点的初始位置：每行 4 个，从左到右、从上到下。打开之后可以拖
const W = 184
const H = 68
const PER_ROW = 4
const at = (i: number) => ({ x: (i % PER_ROW) * (W + 72), y: Math.floor(i / PER_ROW) * (H + 92) })

type StageNode = Node<{ stage: StageChange }, 'stage'>

/** 画板上的一个阶段：样子和页面上别的卡片一致，用的是我们自己的组件和令牌 */
function StageCard({ data }: NodeProps<StageNode>) {
  const s = data.stage
  const hidden = 'size-px min-h-0 min-w-0 border-0 opacity-0'
  return (
    <div
      style={{ width: W, height: H }}
      className={cn('flex flex-col justify-center rounded-box bg-surface px-3.5 font-sans text-base text-ink shadow-card', s.change === 'removed' && 'bg-transparent shadow-none', isChanged(s) && s.change !== 'removed' && 'shadow-selected')}
    >
      <Handle id="in" type="target" position={Position.Left} className={hidden} />
      <Handle id="out" type="source" position={Position.Right} className={hidden} />
      <Handle id="back-out" type="source" position={Position.Top} className={hidden} />
      <Handle id="back-in-top" type="target" position={Position.Top} className={hidden} />
      <Handle id="back-in-bottom" type="target" position={Position.Bottom} className={hidden} />
      <span className="flex items-center justify-between gap-2">
        <span className={cn('truncate font-medium', !isChanged(s) && 'font-normal text-ink-2', s.change === 'removed' && 'text-ink-3 line-through')}>{s.stage}</span>
        {isChanged(s) && <Badge variant="neutral">{s.change === 'added' ? '新增' : s.change === 'removed' ? '删除' : '修改'}</Badge>}
      </span>
      {isChanged(s) && s.change === undefined && <span className="truncate text-xs text-ink-3">{s.summary}</span>}
    </div>
  )
}
const nodeTypes = { stage: StageCard }

/**
 * 画板：看整个流程。用开源的 React Flow（@xyflow/react，MIT）承载拖动、缩放和连线，
 * 节点是我们自己的组件，颜色通过它的 CSS 变量接到令牌上（见 shell/proto.css 的 .chat-canvas）。
 * 这一版只读：能拖、能缩放，不能改流程。
 */
export function FlowCanvas({ change, onBack }: { change: WorkflowChange; onBack: () => void }) {
  const stages = change.stages
  const nodes: StageNode[] = stages.map((s, i) => ({ id: s.stage, type: 'stage', position: at(i), data: { stage: s } }))
  const edges: Edge[] = [
    ...stages.slice(0, -1).map((s, i) => ({ id: `${s.stage}-next`, source: s.stage, target: stages[i + 1]!.stage, sourceHandle: 'out', targetHandle: 'in', type: 'smoothstep' })),
    ...stages
      .filter(s => s.back !== undefined)
      .map(s => {
        const from = at(stages.indexOf(s))
        const to = at(stages.findIndex(x => x.stage === s.back))
        return {
          id: `${s.stage}-back`,
          source: s.stage,
          target: s.back!,
          sourceHandle: 'back-out',
          targetHandle: from.x === to.x && to.y < from.y ? 'back-in-bottom' : 'back-in-top',
          type: 'smoothstep',
          label: '不通过',
          style: { strokeDasharray: '4 4' },
        }
      }),
  ]
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
      <div className="chat-canvas min-h-96 flex-1 border-t border-line">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.15, maxZoom: 1 }} minZoom={0.3} nodesConnectable={false} elementsSelectable={false}>
          <Background color="var(--line)" gap={24} size={1.5} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}
