// SQLite 存储：任务状态快照 + 只追加的事件记录。每次 dispatch 在一个写事务里"读状态 → reduce → 写事件和快照"，
// 所以 runner 和 `eos answer` 这样的多个进程同时写，也不会互相覆盖。
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { newTask, reduce } from '../engine/machine.ts'
import type { ConventionDoc, Event, Step, Task, TaskStatus } from '../engine/types.ts'
import type {
  Actor,
  ConventionKind,
  ConventionRow,
  ConventionSummary,
  Decision,
  EventRow,
  ProposalEvent,
  ProposalInput,
  ProposalRow,
  ProposalStatus,
  TaskMeta,
  TaskSummary,
  TraceRow,
} from './types.ts'
import type { TraceEvent } from '../trace/types.ts'
import { DEFAULT_MAX_FIXES } from '../workflow/parse.ts'
import type { Workflow } from '../workflow/types.ts'

export type { Actor, EventRow, TaskMeta, TaskSummary, TraceRow } from './types.ts'

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
);
CREATE TABLE IF NOT EXISTS conventions (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  note TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, name, version)
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  target_kind TEXT NOT NULL,
  target_name TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence TEXT NOT NULL,
  scope TEXT NOT NULL,
  generator TEXT,
  actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposal_events (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  version INTEGER,
  PRIMARY KEY (proposal_id, seq)
);`

/**
 * 之前保存的任务没有这些字段（任务的 docs、fixes、scopeNotices，对话的 review，工作流快照里节点的 checks、maxFixes 和 docs，
 * 角色的 writePaths、denyTools、skills、mcp）：
 * 读出时补上默认值，引擎内部只信任完整的 Task。
 */
export const upgradeTask = (t: Task): Task => ({
  ...t,
  docs: t.docs ?? [],
  fixes: t.fixes ?? 0,
  scopeNotices: t.scopeNotices ?? {},
  workflow: {
    ...t.workflow,
    docs: t.workflow.docs ?? [],
    // 第 2 块之前的角色没有写入路径、工具组、技能和 MCP：按原来的行为补上（可写角色能写整个 worktree）。
    roles: Object.fromEntries(
      Object.entries(t.workflow.roles).map(([k, r]) => [
        k,
        {
          ...r,
          writePaths: r.writePaths ?? (r.write === 'worktree' ? ['**'] : []),
          denyTools: r.denyTools ?? [],
          skills: r.skills ?? [],
          mcp: r.mcp ?? [],
        },
      ]),
    ),
    nodes: t.workflow.nodes.map(n => ({ ...n, checks: n.checks ?? [], ...(n.kind === 'agent' ? { maxFixes: n.maxFixes ?? DEFAULT_MAX_FIXES } : {}) })),
  },
  ...(t.dialog === undefined ? {} : { dialog: { ...t.dialog, review: t.dialog.review ?? (t.dialog.round > 1 ? 'reply' : 'first') } }),
})

export class Store {
  readonly db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
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
    return row === undefined ? undefined : upgradeTask(JSON.parse(row.state) as Task)
  }

  private append(id: string, at: number, actor: Actor, event: EventRow['event'], accepted: boolean, reason?: string): void {
    const next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE task_id = ?').get(id) as { n: number }).n
    this.db
      .prepare('INSERT INTO events (task_id, seq, at, actor, event, accepted, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, next, at, actor, JSON.stringify(event), accepted ? 1 : 0, reason ?? null)
  }

  create(p: { id: string; request: string; context?: string; workflow: Workflow; workflowSource: string; docs?: ConventionDoc[]; meta: TaskMeta }, at: number, actor: Actor = 'cli'): Task {
    return this.tx(() => {
      const task = newTask({ id: p.id, request: p.request, workflow: p.workflow, docs: p.docs ?? [], ...(p.context === undefined ? {} : { context: p.context }) }, at)
      this.db
        .prepare('INSERT INTO tasks (id, created_at, updated_at, status, request, workflow_name, workflow_source, meta, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(p.id, at, at, task.status, p.request, p.workflow.name, p.workflowSource, JSON.stringify(p.meta), JSON.stringify(task))
      this.append(p.id, at, actor, { kind: 'created' }, true)
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

  /** 任务创建的时刻。 */
  createdAt(id: string): number {
    const row = this.db.prepare('SELECT created_at FROM tasks WHERE id = ?').get(id) as { created_at: number } | undefined
    if (row === undefined) throw new Error(`没有任务 ${id}`)
    return Number(row.created_at)
  }

  meta(id: string): TaskMeta {
    const row = this.db.prepare('SELECT meta FROM tasks WHERE id = ?').get(id) as { meta: string } | undefined
    if (row === undefined) throw new Error(`没有任务 ${id}`)
    return JSON.parse(row.meta) as TaskMeta
  }

  /** 每个任务用的仓库（只读 meta 里的这两项，不解析整个 meta），新的在前：repo 是 worktree 所在的仓库，remote 是托管平台上的网页地址。 */
  taskRepos(): { repo: string; remote?: string; createdAt: number }[] {
    return (
      this.db.prepare("SELECT json_extract(meta, '$.repo') AS repo, json_extract(meta, '$.remote.webUrl') AS remote, created_at FROM tasks ORDER BY created_at DESC").all() as Record<string, unknown>[]
    )
      .filter(r => typeof r.repo === 'string')
      .map(r => ({ repo: String(r.repo), ...(typeof r.remote === 'string' ? { remote: r.remote } : {}), createdAt: Number(r.created_at) }))
  }

  list(): TaskSummary[] {
    return (this.db.prepare('SELECT id, status, request, workflow_name, created_at, updated_at FROM tasks ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(r => ({
      id: String(r.id),
      status: r.status as TaskStatus,
      request: String(r.request),
      workflow: String(r.workflow_name),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }))
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
    return (this.db.prepare('SELECT call_id, seq, event FROM trace WHERE task_id = ? ORDER BY call_id, seq').all(id) as Record<string, unknown>[]).map(r => ({
      call: String(r.call_id),
      seq: Number(r.seq),
      event: JSON.parse(String(r.event)) as TraceEvent,
    }))
  }

  events(id: string): EventRow[] {
    return (this.db.prepare('SELECT seq, at, actor, event, accepted, reason FROM events WHERE task_id = ? ORDER BY seq').all(id) as Record<string, unknown>[]).map(r => ({
      seq: Number(r.seq),
      at: Number(r.at),
      actor: r.actor as Actor,
      event: JSON.parse(String(r.event)),
      accepted: r.accepted === 1,
      ...(r.reason === null ? {} : { reason: String(r.reason) }),
    }))
  }

  /** 团队约定（工作流和文档）：每次保存追加一个新版本，旧版本不改不删。最新版本就是正在使用的版本。 */
  saveConvention(p: { kind: ConventionKind; name: string; content: string; note: string; actor: string }, at: number): ConventionRow {
    return this.tx(() => this.insertConvention(p, at))
  }

  private insertConvention(p: { kind: ConventionKind; name: string; content: string; note: string; actor: string }, at: number): ConventionRow {
    const version = (this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM conventions WHERE kind = ? AND name = ?').get(p.kind, p.name) as { n: number }).n
    this.db.prepare('INSERT INTO conventions (kind, name, version, content, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.kind, p.name, version, p.content, p.note, p.actor, at)
    return { ...p, version, createdAt: at }
  }

  /**
   * 只有这个约定的最新版本仍是 expected（undefined：还没有任何版本）时才写入新版本；判断和写入在同一个事务里，
   * 两个进程同时保存基于同一版本的修改时只有一个成功。返回写入的行，或者 stale 和现在的最新版本。
   * also：写入之后、提交之前在同一个事务里运行（例如记下提议已保存）；它抛错时整个事务回滚，约定也不写。
   */
  saveConventionIfLatest(
    p: { kind: ConventionKind; name: string; content: string; note: string; actor: string },
    expected: number | undefined,
    at: number,
    also: (row: ConventionRow) => void = () => {},
  ): ConventionRow | { stale: true; latest?: number } {
    return this.tx(() => {
      const latest = this.latestVersion(p.kind, p.name)
      if (latest !== expected) return { stale: true, ...(latest === undefined ? {} : { latest }) }
      const row = this.insertConvention(p, at)
      also(row)
      return row
    })
  }

  /** 某个约定的最新版本号（只查版本号，不读内容）。 */
  latestVersion(kind: ConventionKind, name: string): number | undefined {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM conventions WHERE kind = ? AND name = ?').get(kind, name) as { v: number | null }
    return r.v === null ? undefined : Number(r.v)
  }

  /** 改进提案：写入提案和第一条「待审批」状态。提案本身不改任何约定。 */
  addProposal(p: ProposalInput, at: number): ProposalRow {
    return this.tx(() => {
      const r = this.db
        .prepare('INSERT INTO proposals (created_at, target_kind, target_name, base_version, content, rationale, evidence, scope, generator, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          at,
          p.target.kind,
          p.target.name,
          p.baseVersion,
          p.content,
          p.rationale,
          JSON.stringify(p.evidence),
          JSON.stringify(p.scope),
          p.generator === undefined ? null : JSON.stringify(p.generator),
          p.actor,
        )
      const id = Number(r.lastInsertRowid)
      this.appendProposalEvent(id, { at, status: 'pending', actor: p.actor })
      return this.proposalRow(id)!
    })
  }

  private appendProposalEvent(id: number, e: Omit<ProposalEvent, 'seq'>): void {
    const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM proposal_events WHERE proposal_id = ?').get(id) as { n: number }).n
    this.db
      .prepare('INSERT INTO proposal_events (proposal_id, seq, at, status, actor, reason, version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, seq, e.at, e.status, e.actor, e.reason ?? null, e.version ?? null)
  }

  private proposalRow(id: number): ProposalRow | undefined {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (r === undefined) return undefined
    const events = (this.db.prepare('SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY seq').all(id) as Record<string, unknown>[]).map(e => ({
      seq: Number(e.seq),
      at: Number(e.at),
      status: e.status as ProposalStatus,
      actor: String(e.actor),
      ...(e.reason === null ? {} : { reason: String(e.reason) }),
      ...(e.version === null ? {} : { version: Number(e.version) }),
    }))
    return {
      id,
      createdAt: Number(r.created_at),
      target: { kind: r.target_kind as ConventionKind, name: String(r.target_name) },
      baseVersion: Number(r.base_version),
      content: String(r.content),
      rationale: String(r.rationale),
      evidence: JSON.parse(String(r.evidence)) as string[],
      scope: JSON.parse(String(r.scope)) as ProposalRow['scope'],
      ...(r.generator === null ? {} : { generator: JSON.parse(String(r.generator)) as ProposalRow['generator'] }),
      actor: String(r.actor),
      status: events.at(-1)!.status,
      events,
    }
  }

  proposal(id: number): ProposalRow | undefined {
    return this.proposalRow(id)
  }

  /** 所有提案，新的在前。 */
  proposals(): ProposalRow[] {
    return (this.db.prepare('SELECT id FROM proposals ORDER BY id DESC').all() as { id: number }[]).map(r => this.proposalRow(Number(r.id))!)
  }

  /**
   * 审批提案（一个事务）：只有待审批的提案能审批。
   * 批准：目标约定的最新版本不是提案基于的版本时记「已过期」并拒绝批准；再用 validate 校验内容（在同一个事务里，
   * 期间别的进程改不了它引用的约定），不合格就不批准、保持待审批；都通过才写入约定的新版本，记「已批准」和新版本号。
   */
  decideProposal(
    id: number,
    d: { status: 'approved'; note: (row: ProposalRow) => string; reason?: string; validate: (row: ProposalRow) => string[] } | { status: 'rejected'; reason: string },
    at: number,
    actor: string,
  ): Decision {
    return this.tx((): Decision => {
      const row = this.proposalRow(id)
      if (row === undefined) return { ok: false, reason: 'missing' }
      if (row.status !== 'pending') return { ok: false, reason: 'not_pending', row }
      if (d.status === 'rejected') {
        this.appendProposalEvent(id, { at, status: 'rejected', actor, reason: d.reason })
        return { ok: true, row: this.proposalRow(id)! }
      }
      const latest = this.latestVersion(row.target.kind, row.target.name)
      if (latest !== row.baseVersion) {
        this.appendProposalEvent(id, { at, status: 'stale', actor, reason: `目标已是第 ${latest ?? 0} 版，提案基于第 ${row.baseVersion} 版` })
        return { ok: false, reason: 'stale', row: this.proposalRow(id)! }
      }
      const errors = d.validate(row)
      if (errors.length > 0) return { ok: false, reason: 'invalid', errors, row }
      const saved = this.insertConvention({ kind: row.target.kind, name: row.target.name, content: row.content, note: d.note(row), actor }, at)
      this.appendProposalEvent(id, { at, status: 'approved', actor, version: saved.version, ...(d.reason === undefined || d.reason === '' ? {} : { reason: d.reason }) })
      return { ok: true, row: this.proposalRow(id)! }
    })
  }

  /** 这个名字还没有任何版本时才写入第 1 版（同一个事务里判断，多个进程同时启动也只写一次）。返回是否写入。 */
  seedConvention(p: { kind: ConventionKind; name: string; content: string; note: string; actor: string }, at: number): boolean {
    return this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM conventions WHERE kind = ? AND name = ? LIMIT 1').get(p.kind, p.name) !== undefined) return false
      this.db.prepare('INSERT INTO conventions (kind, name, version, content, note, actor, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)').run(p.kind, p.name, p.content, p.note, p.actor, at)
      return true
    })
  }

  /** 某个约定的指定版本；不给版本就是最新版本。 */
  convention(kind: ConventionKind, name: string, version?: number): ConventionRow | undefined {
    const row = (
      version === undefined
        ? this.db.prepare('SELECT * FROM conventions WHERE kind = ? AND name = ? ORDER BY version DESC LIMIT 1').get(kind, name)
        : this.db.prepare('SELECT * FROM conventions WHERE kind = ? AND name = ? AND version = ?').get(kind, name, version)
    ) as Record<string, unknown> | undefined
    return row === undefined ? undefined : conventionRow(row)
  }

  /** 所有版本，新的在前。 */
  conventionHistory(kind: ConventionKind, name: string): ConventionRow[] {
    return (this.db.prepare('SELECT * FROM conventions WHERE kind = ? AND name = ? ORDER BY version DESC').all(kind, name) as Record<string, unknown>[]).map(conventionRow)
  }

  /** 每个约定一行：最新版本号和更新时间。 */
  conventions(kind: ConventionKind): ConventionSummary[] {
    return (
      this.db.prepare('SELECT name, MAX(version) AS version, MAX(created_at) AS updated_at FROM conventions WHERE kind = ? GROUP BY name ORDER BY name').all(kind) as Record<string, unknown>[]
    ).map(r => ({ kind, name: String(r.name), version: Number(r.version), updatedAt: Number(r.updated_at) }))
  }
}

const conventionRow = (r: Record<string, unknown>): ConventionRow => ({
  kind: r.kind as ConventionKind,
  name: String(r.name),
  version: Number(r.version),
  content: String(r.content),
  note: String(r.note),
  actor: String(r.actor),
  createdAt: Number(r.created_at),
})
