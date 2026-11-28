// 按对话里的任务提议建任务：唯一一条把 agent 的任务提议变成任务的路径，只由人触发（命令行 eos chat create）。
// agent 能触发的模块（端点、工具、提议、对话流程、存储）都不引用这个文件（tests/chat-tasks.test.ts 核对）。
// - 作废的、已经创建过的不建；提议所在的那一轮还没有回复的也不建：那一轮之后可能被作废，建了就撤不回。
// - 人可以改三项（仓库、工作流、需求）：改过的仓库不要求是用过的，和直接建任务一样由 Supervisor.create 检查。
// - 同一条提议同一时间只有一处在建（锁 chat-task-<号>）：建任务要克隆、建 worktree，可能要一会儿，两处同时点不能建出两个任务。
import { join } from 'node:path'
import type { CreateInput, Created } from '../runner/supervisor.ts'
import { acquire } from '../runner/lock.ts'
import { turnAnswered } from './save.ts'
import type { ChatStore } from './store.ts'
import type { ChatActor, TaskInput, TaskProposal, TaskProposalView } from './types.ts'

export type CreateOutcome = { ok: true; taskId: string; proposal: TaskProposal } | { ok: false; error: string }

/** 一条任务提议现在的状态（命令行和网页共用）。 */
export const viewTaskProposal = (p: TaskProposal, chats: ChatStore): TaskProposalView => ({
  proposal: p,
  state: p.created !== undefined ? 'created' : p.voided !== undefined ? 'voided' : !turnAnswered(p, chats) ? 'unanswered' : 'pending',
})

export const createFromProposal = async (o: {
  chats: ChatStore
  /** 建任务（不运行）：Supervisor.create。 */
  create: (input: CreateInput) => Promise<Created>
  dataDir: string
  redact: (s: string) => string
  id: number
  actor: ChatActor
  /** 人在确认时改过的项；不给的用提议里的。 */
  edits?: Partial<TaskInput>
  now: () => number
}): Promise<CreateOutcome> => {
  const lock = acquire(join(o.dataDir, 'locks'), `chat-task-${o.id}`)
  if ('heldBy' in lock) return { ok: false, error: `任务提议 #${o.id} 正在被进程 ${lock.heldBy} 创建` }
  try {
    const p = o.chats.taskProposal(o.id)
    if (p === undefined) return { ok: false, error: `没有任务提议 #${o.id}` }
    const v = viewTaskProposal(p, o.chats)
    if (v.state === 'created') return { ok: false, error: `任务提议 #${p.id} 已经创建过任务 ${p.created!.taskId}` }
    if (v.state === 'voided') return { ok: false, error: `任务提议 #${p.id} 已作废，不能创建：${p.voided!}` }
    if (v.state === 'unanswered') return { ok: false, error: `任务提议 #${p.id} 所在的那一轮还没有回复（还在进行，或者没做完），不能创建：等这一轮结束再看` }
    const input: TaskInput = { ...p.input, ...o.edits }
    if (o.redact(input.request) !== input.request) return { ok: false, error: '需求里有凭据值：需求会以明文交给任务里的 agent，不能创建' }
    const created = await o.create({ ...input, origin: `来自对话 ${p.chatId} 的任务提议 #${p.id}` })
    if (!created.ok) return created
    // 锁保证没有别处在建；作废只发生在那一轮没有回复时，上面已经核对过那一轮有回复。
    if (!o.chats.markTaskCreated(p.id, { taskId: created.id, actor: o.actor, at: o.now(), input })) throw new Error(`任务 ${created.id} 已创建，但没能记到任务提议 #${p.id} 上`)
    return { ok: true, taskId: created.id, proposal: o.chats.taskProposal(p.id)! }
  } finally {
    lock.release()
  }
}
