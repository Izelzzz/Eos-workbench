// SQLite 存储：任务状态快照 + 只追加的事件记录。每次 dispatch 在一个写事务里"读状态 → reduce → 写事件和快照"，
// 所以 runner 和 `eos answer` 这样的多个进程同时写，也不会互相覆盖。
import { DatabaseSync } from 'node:sqlite'
import { newTask, reduce } from '../engine/machine.ts'
import type { Event, Step, Task, TaskStatus } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { Workflow } from '../workflow/types.ts'

/** 谁发出的事件：命令行、runner 自己、执行器（agent 回复或提问）。 */
export type Actor = 'cli' | 'runner' | 'executor'

export type EventRow = { seq: number; at: number; actor: Actor; event: Event | { kind: 'created' }; accepted: boolean; reason?: string }

export type TaskSummary = { id: string; status: TaskStatus; request: string; workflow: string; createdAt: number; updatedAt: number }

export type TraceRow = { call: string; seq: number; event: TraceEvent }

export type TaskMeta = { repo: string; worktree: string; branch: string; baseSha: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  request TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_source TEXT NOT NULL,
  meta TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  accepted INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS trace (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (task_id, call_id, seq)
);`

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path, { timeout: 10_000 })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private load(id: string): Task | undefined {
    const row = this.db.prepare('SELECT state FROM tasks WHERE id = ?').get(id) as { state: string } | undefined
    return row === undefined ? undefined : (JSON.parse(row.state) as Task)
  }

  private append(id: string, at: number, actor: Actor, event: EventRow['event'], accepted: boolean, reason?: string): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE task_id = ?').get(id) as { n: number }).n
    this.db.prepare('INSERT INTO events (task_id, seq, at, actor, event, accepted, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, next, at, actor, JSON.stringify(event), accepted ? 1 : 0, reason ?? null)
  }

  create(p: { id: string; request: string; context?: string; workflow: Workflow; workflowSource: string; meta: TaskMeta }, at: number): Task {
    return this.tx(() => {
      const task = newTask({ id: p.id, request: p.request, workflow: p.workflow, ...(p.context === undefined ? {} : { context: p.context }) }, at)
      this.db.prepare('INSERT INTO tasks (id, created_at, updated_at, status, request, workflow_name, workflow_source, meta, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.id, at, at, task.status, p.request, p.workflow.name, p.workflowSource, JSON.stringify(p.meta), JSON.stringify(task))
      this.append(p.id, at, 'cli', { kind: 'created' }, true)
      return task
    })
  }

  /** 读最新状态、reduce、写事件；被拒绝的事件也记下来（accepted = 0），状态不变。 */
  dispatch(id: string, event: Event, at: number, actor: Actor): Step {
    return this.tx(() => {
      const task = this.load(id)
      if (task === undefined) throw new Error(`没有任务 ${id}`)
      const step = reduce(task, event, at)
      this.append(id, at, actor, event, step.accepted, step.reason)
      if (step.accepted) {
        this.db.prepare('UPDATE tasks SET state = ?, status = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(step.task), step.task.status, at, id)
      }
      return step
    })
  }

  get(id: string): Task | undefined {
    return this.load(id)
  }

  meta(id: string): TaskMeta {
    const row = this.db.prepare('SELECT meta FROM tasks WHERE id = ?').get(id) as { meta: string } | undefined
    if (row === undefined) throw new Error(`没有任务 ${id}`)
    return JSON.parse(row.meta) as TaskMeta
  }

  list(): TaskSummary[] {
    return (this.db.prepare('SELECT id, status, request, workflow_name, created_at, updated_at FROM tasks ORDER BY created_at DESC').all() as Record<string, unknown>[])
      .map(r => ({ id: String(r.id), status: r.status as TaskStatus, request: String(r.request), workflow: String(r.workflow_name), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }))
  }

  /** 追加一次调用的 trace 事件（只追加）。 */
  appendTrace(id: string, call: string, events: TraceEvent[]): void {
    if (events.length === 0) return
    this.tx(() => {
      let next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM trace WHERE task_id = ? AND call_id = ?').get(id, call) as { n: number }).n
      const insert = this.db.prepare('INSERT INTO trace (task_id, call_id, seq, event) VALUES (?, ?, ?, ?)')
      for (const e of events) insert.run(id, call, ++next, JSON.stringify(e))
    })
  }

  hasTrace(id: string, call: string): boolean {
    return this.db.prepare('SELECT 1 FROM trace WHERE task_id = ? AND call_id = ? LIMIT 1').get(id, call) !== undefined
  }

  trace(id: string): TraceRow[] {
    return (this.db.prepare('SELECT call_id, seq, event FROM trace WHERE task_id = ? ORDER BY call_id, seq').all(id) as Record<string, unknown>[])
      .map(r => ({ call: String(r.call_id), seq: Number(r.seq), event: JSON.parse(String(r.event)) as TraceEvent }))
  }

  events(id: string): EventRow[] {
    return (this.db.prepare('SELECT seq, at, actor, event, accepted, reason FROM events WHERE task_id = ? ORDER BY seq').all(id) as Record<string, unknown>[])
      .map(r => ({ seq: Number(r.seq), at: Number(r.at), actor: r.actor as Actor, event: JSON.parse(String(r.event)), accepted: r.accepted === 1,
        ...(r.reason === null ? {} : { reason: String(r.reason) }) }))
  }
}
