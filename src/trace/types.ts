// trace 的类型：执行器把 agent 运行时的事件归一化成 TraceEvent，trace/build.ts 把它们整理成 Span 树给 Web 展示。
import type { Purpose, Usage } from '../engine/types.ts'

export type ToolCall = { id: string; name: string; args: string }

/** 一次 agent 调用期间发生的事，时间 t 是毫秒时间戳。step 是 agent 内部的第几次模型请求。 */
export type TraceEvent =
  /** call 记下这次调用属于哪个节点、角色和用途：调用被中止后不在任务状态里了，trace 仍能把它放回原处。 */
  | { kind: 'call_start'; t: number; call?: { node: string; role: string; purpose: Purpose; prompt: string } }
  | { kind: 'step_start'; t: number; step: number }
  | { kind: 'model'; t: number; step: number; model?: string; usage: Usage; reasoning: string; text: string; toolCalls: ToolCall[] }
  | { kind: 'tool_start'; t: number; step: number; id: string; name: string; args: string }
  | { kind: 'tool_end'; t: number; id: string; output: string; isError: boolean }
  | { kind: 'step_end'; t: number; step: number }

export type SpanKind = 'task' | 'node' | 'call' | 'model' | 'tool' | 'question' | 'answer' | 'note'
export type SpanStatus = 'ok' | 'error' | 'running' | 'waiting' | 'pending'

export type Span = {
  id: string
  kind: SpanKind
  name: string
  start: number
  /** 没有结束时间表示还在进行。 */
  end?: number
  status: SpanStatus
  model?: string
  usage?: Usage
  input?: string
  output?: string
  reasoning?: string
  /** 右侧详情里展示的键值对。 */
  meta: Record<string, string>
  children: Span[]
}
