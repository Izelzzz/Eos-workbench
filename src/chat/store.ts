// 对话的存储：和任务共用一个 SQLite 文件，表是自己的（chats、chat_messages、chat_trace），只追加。
// 平台重启后从这里读出对话记录接着聊；agent 那一侧的会话由执行器按对话 id 续接。
import type { DatabaseSync } from 'node:sqlite'
import { addUsage, zeroUsage } from '../engine/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ChatActor, ChatCall, ChatDetail, ChatMessage, ChatMetrics, ChatSummary, ChatTraceRow } from './types.ts'
import { CHAT_PURPOSE } from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  actor TEXT NOT NULL
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
);`

/** 标题取第一条消息的开头。 */
const TITLE_CHARS = 40

type NewMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, 'seq'> : never) : never

export class ChatStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA)
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

  create(p: { id: string; firstMessage: string; actor: ChatActor }, at: number): ChatSummary {
    const line = p.firstMessage.trim().split('\n')[0] ?? ''
    const title = line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line
    this.db.prepare('INSERT INTO chats (id, created_at, updated_at, title, actor) VALUES (?, ?, ?, ?, ?)').run(p.id, at, at, title, p.actor)
    return this.summary(p.id)!
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

  metrics(id: string): ChatMetrics {
    const log = this.log(id)
    const calls = log.flatMap(m => (m.role === 'assistant' ? [m.call] : []))
    return {
      purpose: CHAT_PURPOSE,
      calls: calls.length,
      failed: log.filter(m => m.role === 'error').length,
      usage: calls.reduce((u, c) => addUsage(u, c.usage), zeroUsage()),
      agentMs: calls.reduce((n, c) => n + c.ms, 0),
      reads: calls.reduce((n, c) => n + c.reads.length, 0),
    }
  }
}
