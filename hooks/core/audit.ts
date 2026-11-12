// 审计记录：每个交给状态机的事件，以及任务创建、子 agent 启动，各写一行到任务目录的 events.jsonl。纯函数。
import type { StageId, StageStatus, Task, TaskStatus } from '../../types'
import type { Action, Event } from './pipeline'

/** 谁触发的：/eos 命令、面板按钮、子 agent 的回报、命令阶段的进程、Eos 自己。 */
export type Actor = 'command' | 'panel' | 'agent' | 'process' | 'system'

/** 不经过状态机、但也要留痕的动作。 */
export type Notice =
  | { kind: 'create'; title: string; request: string }
  | {
      kind: 'agent'
      stage: StageId
      seq: number
      agentId: string
      model?: string
      effort?: string | number
      skills?: string[]
      /** 这些 skill 不能预加载（disable-model-invocation），改为在提示词里要求先读的 SKILL.md。 */
      readFirst?: string[]
    }

export type AuditEvent = Event | Notice

/** 事件前后，任务与相关阶段的状态。 */
export type Snapshot = { status: TaskStatus; current: StageId; stageStatus: StageStatus; seq: number }

export type AuditEntry = {
  ts: number
  taskId: string
  actor: Actor
  event: AuditEvent
  stage: StageId
  before?: Snapshot
  after: Snapshot
  action?: Action
  /** false：状态机原样返回了任务（例如被拒绝的驳回、已结束的任务收到批准）。 */
  accepted: boolean
}

const snapshot = (t: Task, stage: StageId): Snapshot => ({
  status: t.status,
  current: t.current,
  stageStatus: t.stages[stage].status,
  seq: t.stages[stage].seq,
})

const stageOf = (event: AuditEvent, task: Task): StageId => ('stage' in event ? event.stage : task.current)

export const auditEntry = (p: {
  before?: Task
  after: Task
  event: AuditEvent
  action?: Action
  actor: Actor
  ts: number
}): AuditEntry => {
  const stage = stageOf(p.event, p.before ?? p.after)
  return {
    ts: p.ts,
    taskId: p.after.id,
    actor: p.actor,
    event: JSON.parse(JSON.stringify(p.event)) as AuditEvent,
    stage,
    ...(p.before === undefined ? {} : { before: snapshot(p.before, stage) }),
    after: snapshot(p.after, stage),
    ...(p.action === undefined ? {} : { action: p.action }),
    accepted: p.before === undefined || p.before !== p.after,
  }
}

/** 解析 events.jsonl：坏行跳过（例如写到一半的最后一行），不让整条时间线读不出来。 */
export const parseEntries = (text: string): AuditEntry[] =>
  text
    .split('\n')
    .filter(line => line.trim() !== '')
    .flatMap(line => {
      try {
        return [JSON.parse(line) as AuditEntry]
      } catch {
        return []
      }
    })
