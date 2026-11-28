// 对话的存储：和任务共用一个 SQLite 文件，表是自己的（chats、chat_messages、chat_trace、chat_proposals、chat_task_proposals）。
// 消息和 trace 只追加；提议只改作废、保存记录和确认码的随机值；任务提议只改作废和创建记录。
// 平台重启后从这里读出对话记录接着聊；agent 那一侧的会话由执行器按对话 id 续接。
import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { addUsage, zeroUsage } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ChatActor, ChatCall, ChatDetail, ChatMessage, ChatMetrics, ChatProposal, ChatSummary, ChatTraceRow, ProposalKind, ProposalSaved, TaskCreated, TaskInput, TaskProposal } from './types.ts'
import { PROPOSE_TOOL } from './proposals.ts'
import { PROPOSE_TASK_TOOL } from './tasks.ts'
import { CHAT_PURPOSE } from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  actor TEXT NOT NULL,
  executor TEXT
);
CREATE TABLE IF NOT EXISTS chat_messages (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  seq INTEGER NOT NULL,
  at INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  actor TEXT,
  call TEXT,
  PRIMARY KEY (chat_id, seq)
);
CREATE TABLE IF NOT EXISTS chat_trace (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (chat_id, call_id, seq)
);
CREATE TABLE IF NOT EXISTS chat_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  call_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  base_version INTEGER,
  content TEXT NOT NULL,
  rationale TEXT NOT NULL,
  permissions TEXT NOT NULL,
  voided TEXT,
  saved_version INTEGER,
  saved_actor TEXT,
  saved_at INTEGER,
  confirm_salt TEXT
);
CREATE TABLE IF NOT EXISTS chat_task_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  call_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  repo TEXT NOT NULL,
  workflow TEXT NOT NULL,
  request TEXT NOT NULL,
  voided TEXT,
  task_id TEXT,
  task_actor TEXT,
  task_at INTEGER,
  task_input TEXT,
  confirm_salt TEXT
);`

/** 标题取第一条消息的开头。 */
const TITLE_CHARS = 40

type NewMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, 'seq'> : never) : never

export class ChatStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
    // 早先建的 chat_proposals 没有保存记录的几列：补上（CREATE TABLE IF NOT EXISTS 不会改已有的表）。
    // 两个进程同时打开旧库时，后补的那个会碰到「列已存在」：别人补上了，忽略。
    // 早先建的 chats 没有 executor 一列：补上，旧对话这一列是空的（用默认执行器，和它们当初用的一样）。
    for (const [table, name, type] of [
      ['chat_proposals', 'saved_version', 'INTEGER'],
      ['chat_proposals', 'saved_actor', 'TEXT'],
      ['chat_proposals', 'saved_at', 'INTEGER'],
      ['chat_proposals', 'confirm_salt', 'TEXT'],
      ['chats', 'executor', 'TEXT'],
    ] as const) {
      const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name))
      if (!columns.has(name))
        try {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
        } catch (e) {
          if (!/duplicate column/i.test(String(e))) throw e
        }
    }
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

  /** executor：这个对话用的执行器，建对话时定下，之后每一句和找回都用它（不写是默认执行器）。 */
  create(p: { id: string; firstMessage: string; actor: ChatActor; executor?: string }, at: number): ChatSummary {
    const line = p.firstMessage.trim().split('\n')[0] ?? ''
    const title = line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line
    this.db.prepare('INSERT INTO chats (id, created_at, updated_at, title, actor, executor) VALUES (?, ?, ?, ?, ?, ?)').run(p.id, at, at, title, p.actor, p.executor ?? null)
    return this.summary(p.id)!
  }

  /** 对话用的执行器；没有记录（默认执行器，或者是加这一列之前的对话）时 undefined。 */
  executorOf(id: string): string | undefined {
    const r = this.db.prepare('SELECT executor FROM chats WHERE id = ?').get(id) as { executor: string | null } | undefined
    return r?.executor ?? undefined
  }

  /** 追加一条记录，返回它的序号。 */
  append(id: string, m: NewMessage): number {
    return this.tx(() => {
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chat_messages WHERE chat_id = ?').get(id) as { n: number }).n
      this.db
        .prepare('INSERT INTO chat_messages (chat_id, seq, at, role, text, actor, call) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, seq, m.at, m.role, m.text, m.role === 'user' ? m.actor : null, m.role === 'assistant' ? JSON.stringify(m.call) : null)
      this.db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(m.at, id)
      return Number(seq)
    })
  }

  summary(id: string): ChatSummary | undefined {
    return this.summaries('WHERE c.id = ?', id)[0]
  }

  /** 所有对话，最近更新的在前。 */
  list(): ChatSummary[] {
    return this.summaries('')
  }

  private summaries(where: string, ...args: string[]): ChatSummary[] {
    const rows = this.db
      .prepare(`SELECT c.id, c.created_at, c.updated_at, c.title, c.actor, (SELECT COUNT(*) FROM chat_messages m WHERE m.chat_id = c.id) AS n FROM chats c ${where} ORDER BY c.updated_at DESC, c.id`)
      .all(...args) as Record<string, unknown>[]
    return rows.map(r => ({
      id: String(r.id),
      title: String(r.title),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      actor: r.actor as ChatActor,
      messages: Number(r.n),
    }))
  }

  log(id: string): ChatMessage[] {
    return (this.db.prepare('SELECT seq, at, role, text, actor, call FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(id) as Record<string, unknown>[]).map((r): ChatMessage => {
      const base = { seq: Number(r.seq), at: Number(r.at), text: String(r.text) }
      if (r.role === 'user') return { ...base, role: 'user', actor: r.actor as ChatActor }
      if (r.role === 'assistant') return { ...base, role: 'assistant', call: JSON.parse(String(r.call)) as ChatCall }
      return { ...base, role: 'error' }
    })
  }

  detail(id: string): ChatDetail | undefined {
    const s = this.summary(id)
    return s === undefined ? undefined : { ...s, log: this.log(id) }
  }

  appendTrace(id: string, call: string, events: TraceEvent[]): void {
    if (events.length === 0) return
    this.tx(() => {
      let next = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM chat_trace WHERE chat_id = ? AND call_id = ?').get(id, call) as { n: number }).n
      const insert = this.db.prepare('INSERT INTO chat_trace (chat_id, call_id, seq, event) VALUES (?, ?, ?, ?)')
      for (const e of events) insert.run(id, call, ++next, JSON.stringify(e))
    })
  }

  trace(id: string): ChatTraceRow[] {
    return (this.db.prepare('SELECT call_id, seq, event FROM chat_trace WHERE chat_id = ? ORDER BY call_id, seq').all(id) as Record<string, unknown>[]).map(r => ({
      call: String(r.call_id),
      seq: Number(r.seq),
      event: JSON.parse(String(r.event)) as TraceEvent,
    }))
  }

  /** 记下一条提议（只追加）。提议不改任何约定。 */
  addProposal(p: Omit<ChatProposal, 'id' | 'at' | 'voided' | 'saved'>, at: number): ChatProposal {
    const r = this.db
      .prepare('INSERT INTO chat_proposals (chat_id, call_id, created_at, kind, name, base_version, content, rationale, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.chatId, p.call, at, p.kind, p.name, p.baseVersion ?? null, p.content, p.rationale, JSON.stringify(p.permissions))
    return this.proposal(Number(r.lastInsertRowid))!
  }

  /**
   * 一条提议的确认码用的随机值（只由 save.ts 用）：第一次要时生成并记下。
   * 不在 ChatProposal 里、不进 agent 能看到的任何结果，所以 agent 算不出确认码。
   */
  confirmSalt(id: number): string {
    this.db.prepare('UPDATE chat_proposals SET confirm_salt = ? WHERE id = ? AND confirm_salt IS NULL').run(randomBytes(16).toString('hex'), id)
    const r = this.db.prepare('SELECT confirm_salt FROM chat_proposals WHERE id = ?').get(id) as { confirm_salt: string } | undefined
    if (r === undefined) throw new Error(`没有提议 #${id}`)
    return r.confirm_salt
  }

  /** 记下提议已经保存成了哪个版本（只在人确认保存之后由 save.ts 调用）。已经记过的、已作废的不改，返回是否记下。 */
  markSaved(id: number, saved: ProposalSaved): boolean {
    return (
      Number(
        this.db
          .prepare('UPDATE chat_proposals SET saved_version = ?, saved_actor = ?, saved_at = ? WHERE id = ? AND saved_version IS NULL AND voided IS NULL')
          .run(saved.version, saved.actor, saved.at, id).changes,
      ) === 1
    )
  }

  /** 这一轮没有得到回复：这一轮记下的提议（约定和任务）都作废。已经保存、创建过的不会是这一轮的（那一轮还没有回复时不能保存、创建）。 */
  voidProposals(call: string, reason: string): void {
    this.db.prepare('UPDATE chat_proposals SET voided = ? WHERE call_id = ? AND voided IS NULL').run(reason, call)
    this.db.prepare('UPDATE chat_task_proposals SET voided = ? WHERE call_id = ? AND voided IS NULL AND task_id IS NULL').run(reason, call)
  }

  /** 记下一条任务提议（只追加）。它不建任务。 */
  addTaskProposal(p: Omit<TaskProposal, 'id' | 'at' | 'voided' | 'created'>, at: number): TaskProposal {
    const r = this.db
      .prepare('INSERT INTO chat_task_proposals (chat_id, call_id, created_at, title, repo, workflow, request) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(p.chatId, p.call, at, p.title, p.input.repo, p.input.workflow, p.input.request)
    return this.taskProposal(Number(r.lastInsertRowid))!
  }

  taskProposal(id: number): TaskProposal | undefined {
    const r = this.db.prepare('SELECT * FROM chat_task_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? undefined : taskProposalRow(r)
  }

  /** 一个对话的任务提议，先提的在前。 */
  taskProposals(chatId: string): TaskProposal[] {
    return (this.db.prepare('SELECT * FROM chat_task_proposals WHERE chat_id = ? ORDER BY id').all(chatId) as Record<string, unknown>[]).map(taskProposalRow)
  }

  /** 任务提议的确认码用的随机值（只由 create.ts 用），和约定提议的 confirmSalt 一样：第一次要时生成，不进 agent 能看到的任何结果。 */
  taskConfirmSalt(id: number): string {
    this.db.prepare('UPDATE chat_task_proposals SET confirm_salt = ? WHERE id = ? AND confirm_salt IS NULL').run(randomBytes(16).toString('hex'), id)
    const r = this.db.prepare('SELECT confirm_salt FROM chat_task_proposals WHERE id = ?').get(id) as { confirm_salt: string } | undefined
    if (r === undefined) throw new Error(`没有任务提议 #${id}`)
    return r.confirm_salt
  }

  /** 记下任务提议已创建（只由 create.ts 用）。已经创建过或者作废了就不记，返回 false。 */
  markTaskCreated(id: number, c: TaskCreated): boolean {
    const r = this.db
      .prepare('UPDATE chat_task_proposals SET task_id = ?, task_actor = ?, task_at = ?, task_input = ? WHERE id = ? AND task_id IS NULL AND voided IS NULL')
      .run(c.taskId, c.actor, c.at, JSON.stringify(c.input), id)
    return Number(r.changes) === 1
  }

  proposal(id: number): ChatProposal | undefined {
    const r = this.db.prepare('SELECT * FROM chat_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return r === undefined ? undefined : proposalRow(r)
  }

  /** 一个对话的提议，先提的在前。 */
  proposals(chatId: string): ChatProposal[] {
    return (this.db.prepare('SELECT * FROM chat_proposals WHERE chat_id = ? ORDER BY id').all(chatId) as Record<string, unknown>[]).map(proposalRow)
  }

  metrics(id: string): ChatMetrics {
    const log = this.log(id)
    const calls = log.flatMap(m => (m.role === 'assistant' ? [m.call] : []))
    return {
      purpose: CHAT_PURPOSE,
      calls: calls.length,
      failed: log.filter(m => m.role === 'error').length,
      usage: calls.reduce((u, c) => addUsage(u, c.usage), zeroUsage()),
      agentMs: calls.reduce((n, c) => n + c.ms, 0),
      // 读数据的次数：不算提议。
      reads: calls.reduce((n, c) => n + c.reads.filter(r => r.tool !== PROPOSE_TOOL && r.tool !== PROPOSE_TASK_TOOL).length, 0),
    }
  }
}

const proposalRow = (r: Record<string, unknown>): ChatProposal => ({
  id: Number(r.id),
  chatId: String(r.chat_id),
  call: String(r.call_id),
  at: Number(r.created_at),
  kind: r.kind as ProposalKind,
  name: String(r.name),
  ...(r.base_version === null ? {} : { baseVersion: Number(r.base_version) }),
  content: String(r.content),
  rationale: String(r.rationale),
  permissions: JSON.parse(String(r.permissions)) as string[],
  ...(r.voided === null ? {} : { voided: String(r.voided) }),
  ...(r.saved_version === null ? {} : { saved: { version: Number(r.saved_version), actor: r.saved_actor as ChatActor, at: Number(r.saved_at) } }),
})

const taskProposalRow = (r: Record<string, unknown>): TaskProposal => ({
  id: Number(r.id),
  chatId: String(r.chat_id),
  call: String(r.call_id),
  at: Number(r.created_at),
  title: String(r.title),
  input: { repo: String(r.repo), workflow: String(r.workflow), request: String(r.request) },
  ...(r.voided === null ? {} : { voided: String(r.voided) }),
  ...(r.task_id === null ? {} : { created: { taskId: String(r.task_id), actor: r.task_actor as ChatActor, at: Number(r.task_at), input: JSON.parse(String(r.task_input)) as TaskInput } }),
})
