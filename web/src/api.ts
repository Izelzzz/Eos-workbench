// 与后端接口对应的类型和请求。类型从后端源码只做类型导入，前后端用同一份定义。
import type { TaskSummary } from '../../src/store/types.ts'
import type { TaskDetail } from '../../src/web/types.ts'

export type { TaskDetail, TaskSummary }
export type { Span, SpanKind, SpanStatus } from '../../src/trace/types.ts'

const get = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: 'no-store' })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `请求失败：${res.status}`)
  return body as T
}

export const listTasks = () => get<TaskSummary[]>('/api/tasks')
export const getTask = (id: string) => get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`)
