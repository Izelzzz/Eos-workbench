// 工作台的数据：「等你处理」（任务的提问、人的验收、待批的改进提案）和「进行中的任务」。
// workbench 是纯函数（不读存储、不读时钟，方便单测）；readWorkbench 从存储读出进行中的任务和提案交给它。server.ts 只加路由。
import { describePosition } from '../engine/machine.ts'
import type { Question, Task } from '../engine/types.ts'
import type { Store } from '../store/store.ts'
import type { ProposalRow, TaskMeta, TaskSummary } from '../store/types.ts'

/** 等你处理的一件事。at：这件事出现的时刻，越早越靠前 */
export type WorkbenchItem =
  | { kind: 'question'; taskId: string; title: string; repo: string; node?: string; at: number; question: Question }
  | { kind: 'gate'; taskId: string; title: string; repo: string; node: string; round: number; at: number }
  | { kind: 'proposal'; id: number; target: ProposalRow['target']; rationale: string; at: number }

/** 进行中的一个任务。total、done：工作流有几个节点、走完了几个；waiting：在等你回答或验收 */
export type WorkbenchTask = {
  id: string
  title: string
  repo: string
  total: number
  done: number
  state: string
  waiting?: 'question' | 'gate'
  updatedAt: number
}

/** active 最多 ACTIVE_LIMIT 个（等你处理的在前，其余按更新时间从新到旧）；activeTotal 是进行中的总数 */
export type Workbench = { pending: WorkbenchItem[]; active: WorkbenchTask[]; activeTotal: number }

export const ACTIVE_LIMIT = 10
const LIVE = new Set(['running', 'waiting_user', 'waiting_accept'])

export type WorkbenchInput = { tasks: { summary: TaskSummary; task: Task; meta: TaskMeta }[]; proposals: ProposalRow[] }

/** 任务的标题：需求的第一个非空行 */
export const titleOf = (request: string) =>
  request
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '') ?? ''

/** 仓库的显示名：托管平台上的仓库写 owner/name，本地仓库写目录名 */
const repoOf = (meta: TaskMeta) => (meta.remote === undefined ? (meta.repo.replace(/\/+$/, '').split('/').at(-1) ?? meta.repo) : `${meta.remote.owner}/${meta.remote.name}`)

/** 现在要人处理的是什么：agent 或对话循环的提问；停在人验收的卡点上 */
const waitingOf = (task: Task): WorkbenchTask['waiting'] => {
  if (task.status === 'waiting_user' && task.question !== undefined) return 'question'
  if (task.status === 'waiting_accept' && task.gate?.phase === 'decide') {
    const n = task.workflow.nodes.find(x => x.id === task.gate!.node)
    if (n?.kind === 'gate' && n.by.kind === 'human') return 'gate'
  }
  return undefined
}

/**
 * 状态文字。等你回答时写提问的节点；在修正或对话循环里时保留 describePosition 的说明（第几次修正、第几轮）。
 * 等你验收时写卡点和第几次验收。
 */
const stateOf = (task: Task, waiting: WorkbenchTask['waiting']): string => {
  if (waiting === 'gate') return `${task.gate!.node} 第 ${task.gate!.round} 次验收 · 等你验收`
  if (waiting === 'question') {
    if (task.correction !== undefined || task.dialog !== undefined) return `${describePosition(task)} · 等你回答`
    return `${task.question!.node ?? task.workflow.nodes[task.cursor]?.id ?? ''} · 等你回答`
  }
  return describePosition(task)
}

export function workbench({ tasks, proposals }: WorkbenchInput): Workbench {
  const pending: WorkbenchItem[] = []
  const live: WorkbenchTask[] = []
  for (const { summary, task, meta } of tasks) {
    if (!LIVE.has(task.status)) continue
    const title = titleOf(task.request)
    const repo = repoOf(meta)
    const waiting = waitingOf(task)
    if (waiting === 'question') {
      const q = task.question!
      const asked = task.log.findLast(e => e.type === 'question' && e.question.id === q.id)
      pending.push({ kind: 'question', taskId: task.id, title, repo, ...(q.node === undefined ? {} : { node: q.node }), at: asked?.at ?? summary.updatedAt, question: q })
    } else if (waiting === 'gate') {
      pending.push({ kind: 'gate', taskId: task.id, title, repo, node: task.gate!.node, round: task.gate!.round, at: summary.updatedAt })
    }
    live.push({
      id: task.id,
      title,
      repo,
      total: task.workflow.nodes.length,
      done: Math.min(task.cursor, task.workflow.nodes.length),
      state: stateOf(task, waiting),
      ...(waiting === undefined ? {} : { waiting }),
      updatedAt: summary.updatedAt,
    })
  }
  for (const p of proposals) if (p.status === 'pending') pending.push({ kind: 'proposal', id: p.id, target: p.target, rationale: p.rationale, at: p.createdAt })
  pending.sort((a, b) => a.at - b.at)
  live.sort((a, b) => Number(b.waiting !== undefined) - Number(a.waiting !== undefined) || b.updatedAt - a.updatedAt)
  return { pending, active: live.slice(0, ACTIVE_LIMIT), activeTotal: live.length }
}

/** 从存储读：只读进行中的任务（已结束的任务不用重放日志） */
export const readWorkbench = (store: Store): Workbench =>
  workbench({
    tasks: store.list().flatMap(summary => {
      if (!LIVE.has(summary.status)) return []
      const task = store.get(summary.id)
      return task === undefined ? [] : [{ summary, task, meta: store.meta(summary.id) }]
    }),
    proposals: store.proposals(),
  })
