// 与后端接口对应的类型和请求。类型从后端源码只做类型导入，前后端用同一份定义。
import type { TaskSummary } from '../../src/store/types.ts'
import type { ConventionKind, ConventionRow } from '../../src/store/types.ts'
import type {
  ActionResponse, AnswerResponse, ConventionDetail, ConventionsResponse, CreateResponse, FieldError, SaveConventionResponse, TaskDetail, WorkflowInfo,
} from '../../src/web/types.ts'

export type { ConventionDetail, ConventionKind, ConventionRow, ConventionsResponse, FieldError, TaskDetail, TaskSummary, WorkflowInfo }
export type { Span, SpanKind, SpanStatus } from '../../src/trace/types.ts'

const get = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: 'no-store' })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `请求失败：${res.status}`)
  return body as T
}

export const listTasks = () => get<TaskSummary[]>('/api/tasks')
export const getTask = (id: string) => get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`)

/** 写接口统一走这里：JSON 请求体，浏览器自动带上同源 Origin。网络或服务端错误都变成 { ok: false, error }。 */
const post = async <T extends { ok: boolean }>(path: string, body: unknown): Promise<T | { ok: false; error: string }> => {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return (await res.json()) as T
  } catch (e) {
    return { ok: false, error: `请求失败：${(e as Error).message}` }
  }
}

export const listWorkflows = () => get<WorkflowInfo[]>('/api/workflows')
export const createTask = (input: { repo: string; workflow: string; request: string }) => post<CreateResponse>('/api/tasks', input)
export const answerQuestion = (id: string, questionId: string, text: string) =>
  post<AnswerResponse>(`/api/tasks/${encodeURIComponent(id)}/answer`, { questionId, text })
export const taskAction = (id: string, action: 'resume' | 'retry' | 'abort') =>
  post<ActionResponse>(`/api/tasks/${encodeURIComponent(id)}/${action}`, {})

export const listConventions = () => get<ConventionsResponse>('/api/conventions')
const conventionPath = (kind: ConventionKind, name: string) => `/api/conventions/${kind}/${encodeURIComponent(name)}`
export const getConvention = (kind: ConventionKind, name: string) => get<ConventionDetail>(conventionPath(kind, name))
export const saveConvention = (kind: ConventionKind, name: string, body: { content: string; note?: string; validateOnly?: boolean }) =>
  post<SaveConventionResponse>(conventionPath(kind, name), body)
