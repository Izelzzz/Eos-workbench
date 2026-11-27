// 与后端接口对应的类型和请求。类型从后端源码只做类型导入，前后端用同一份定义。
import type { Insights } from '../../src/engine/insights.ts'
import type { TaskSummary } from '../../src/store/types.ts'
import type { ConventionKind, ConventionRow } from '../../src/store/types.ts'
import type {
  ActionResponse,
  AnswerResponse,
  ConventionDetail,
  ConventionsResponse,
  CreateResponse,
  DecideResponse,
  FieldError,
  CorrectRequest,
  CorrectResponse,
  GateRequest,
  GateResponse,
  GenerateResponse,
  ImprovementComparison,
  ProposalDetail,
  ProposalInfo,
  FileChange,
  FileDiff,
  SaveConventionResponse,
  TaskChanges,
  TaskDetail,
  WorkflowInfo,
  CredentialsResponse,
  DeleteCredentialResponse,
  SaveCredentialRequest,
  SaveCredentialResponse,
  ForgeAppsResponse,
  RegisterAppRequest,
  RegisterAppResponse,
  AuthorizeUserResponse,
  RevokeUserResponse,
  ChatStreamLine,
  ChatView,
  SaveChatProposalResponse,
} from '../../src/web/types.ts'
import type { ChatSummary } from '../../src/chat/types.ts'
import type { CredentialKind } from '../../src/credentials/types.ts'

export type { Insights }
export type {
  ConventionDetail,
  ConventionKind,
  ConventionRow,
  ConventionsResponse,
  FieldError,
  CorrectRequest,
  CorrectResponse,
  GateRequest,
  GateResponse,
  GenerateResponse,
  ImprovementComparison,
  ProposalDetail,
  ProposalInfo,
  TaskDetail,
  TaskSummary,
  WorkflowInfo,
}
export type { FileChange, FileDiff, TaskChanges }
export type { CredentialKind, CredentialsResponse, ForgeAppsResponse }
export type { Span, SpanKind, SpanStatus } from '../../src/trace/types.ts'

const get = async <T>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: 'no-store' })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `请求失败：${res.status}`)
  return body as T
}

export const listTasks = () => get<TaskSummary[]>('/api/tasks')
export const getTask = (id: string) => get<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`)
export const getChanges = (id: string) => get<TaskChanges>(`/api/tasks/${encodeURIComponent(id)}/changes`)
export const getFileDiff = (id: string, head: string, path: string) => get<FileDiff>(`/api/tasks/${encodeURIComponent(id)}/changes/diff?${new URLSearchParams({ head, path })}`)
export const getInsights = () => get<Insights>('/api/insights')

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
export const answerQuestion = (id: string, questionId: string, text: string) => post<AnswerResponse>(`/api/tasks/${encodeURIComponent(id)}/answer`, { questionId, text })
export const correctTask = (id: string, body: CorrectRequest) => post<CorrectResponse>(`/api/tasks/${encodeURIComponent(id)}/correct`, body)
export const decideGate = (id: string, body: GateRequest) => post<GateResponse>(`/api/tasks/${encodeURIComponent(id)}/gate`, body)
export const taskAction = (id: string, action: 'resume' | 'retry' | 'abort') => post<ActionResponse>(`/api/tasks/${encodeURIComponent(id)}/${action}`, {})

export const listConventions = () => get<ConventionsResponse>('/api/conventions')
const conventionPath = (kind: ConventionKind, name: string) => `/api/conventions/${kind}/${encodeURIComponent(name)}`
export const getConvention = (kind: ConventionKind, name: string) => get<ConventionDetail>(conventionPath(kind, name))
export const saveConvention = (kind: ConventionKind, name: string, body: { content: string; note?: string; validateOnly?: boolean }) => post<SaveConventionResponse>(conventionPath(kind, name), body)

export const listProposals = () => get<ProposalInfo[]>('/api/improve/proposals')
export const getProposal = (id: number) => get<ProposalDetail>(`/api/improve/proposals/${id}`)
export const generateProposals = (workflow: string, tasks: string[]) => post<GenerateResponse>('/api/improve/generate', { workflow, ...(tasks.length === 0 ? {} : { tasks }) })
export const decideProposal = (id: number, action: 'approve' | 'reject', text: string) =>
  post<DecideResponse>(`/api/improve/proposals/${id}/${action}`, action === 'approve' ? { note: text } : { reason: text })
export const listComparisons = () => get<ImprovementComparison[]>('/api/improve/comparisons')

export const listCredentials = () => get<CredentialsResponse>('/api/credentials')
export const saveCredential = (body: SaveCredentialRequest) => post<SaveCredentialResponse>('/api/credentials', body)
export const deleteCredential = (name: string) => post<DeleteCredentialResponse>('/api/credentials/delete', { name })

export const listForgeApps = () => get<ForgeAppsResponse>('/api/forge-apps')
export const registerForgeApp = (body: RegisterAppRequest) => post<RegisterAppResponse>('/api/forge-apps/register', body)
export const authorizeForgeUser = (name: string) => post<AuthorizeUserResponse>('/api/forge-apps/authorize', { name })
export const revokeForgeUser = (name: string) => post<RevokeUserResponse>('/api/forge-apps/revoke', { name })

export type { ChatStreamLine, ChatSummary, ChatView }
export type { ChatMessage } from '../../src/chat/types.ts'
export type { ProposalView } from '../../src/chat/types.ts'

export const listChats = () => get<ChatSummary[]>('/api/chats')
export const getChat = (id: string) => get<ChatView>(`/api/chats/${encodeURIComponent(id)}`)
export const saveChatProposal = (id: number, body: { confirm?: string; note?: string }) => post<SaveChatProposalResponse>(`/api/chats/proposals/${id}/save`, body)

/** 发一句话（不给 chat 就是新建对话）：服务端一行行推送进度，每收到一行调用 onLine，返回最后的结果那一行。 */
export const sendChat = async (body: { chat?: string; text: string }, onLine: (line: ChatStreamLine) => void): Promise<Extract<ChatStreamLine, { type: 'done' }>> => {
  try {
    const res = await fetch('/api/chats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok || res.body === null) return { type: 'done', ok: false, error: ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `请求失败：${res.status}` }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const l of lines) {
        if (l === '') continue
        const line = JSON.parse(l) as ChatStreamLine
        if (line.type === 'done') return line
        onLine(line)
      }
    }
    return { type: 'done', ok: false, error: '连接断开了：这一轮可能还在进行，稍后刷新看看' }
  } catch (e) {
    return { type: 'done', ok: false, error: `请求失败：${(e as Error).message}` }
  }
}
