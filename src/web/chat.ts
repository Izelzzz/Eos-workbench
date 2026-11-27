// 网页的对话：列表、查看、发话（按步推送进度）、保存提议。和命令行 eos chat 用同一套 Chats、ChatStore 和 save.ts。
// 提议表和约定表必须用同一个数据库连接（save.ts 在一个事务里写两张表）：ChatStore 由这里从 store.db 建，不从外面传进来。
import { Chats, ours } from '../chat/chat.ts'
import { saveProposal, viewProposal, type SaveOutcome } from '../chat/save.ts'
import { ChatStore } from '../chat/store.ts'
import type { DataSource } from '../chat/tools.ts'
import type { Conventions } from '../conventions/conventions.ts'
import { redactDeep } from '../credentials/redact.ts'
import type { Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ChatStreamLine, ChatView } from './types.ts'

/** 一个 trace 事件 → 推给页面的一行进度；不需要显示的返回 undefined。工具的返回内容不推（可能很长，读完的结果在回复里）。 */
export const streamLine = (e: TraceEvent): ChatStreamLine | undefined => {
  if (e.kind === 'tool_start') return { type: 'read', id: e.id, tool: ours(e.name) ?? e.name, args: e.args.slice(0, 500) }
  if (e.kind === 'tool_end' && e.isError) return { type: 'read_failed', id: e.id }
  if (e.kind === 'model' && e.text.trim() !== '') return { type: 'text', text: e.text }
  return undefined
}

export class WebChats {
  readonly chats: ChatStore
  constructor(
    private readonly o: {
      store: Store
      conventions: Conventions
      executor: Executor
      dataDir: string
      redact: (s: string) => string
      changes: DataSource['changes']
      now: () => number
    },
  ) {
    this.chats = new ChatStore(o.store.db)
  }

  private flow(onEvent?: (e: TraceEvent) => void): Chats {
    const data: DataSource = { store: this.o.store, conventions: this.o.conventions, changes: this.o.changes, now: this.o.now }
    return new Chats({ ...this.o, chats: this.chats, data, ...(onEvent === undefined ? {} : { onEvent: (_id, e) => onEvent(e) }) })
  }

  list() {
    return this.chats.list()
  }

  /** 对话记录、提议（按现在的平台状态算状态和权限）和用量。 */
  detail(id: string): ChatView | undefined {
    const d = this.chats.detail(id)
    if (d === undefined) return undefined
    // 整个视图都经过遮蔽：记录里可能有平台在那之后才持有的凭据值（例如用户把 key 贴进对话、之后又存成凭据）。
    const proposals = this.chats.proposals(id).map(p => viewProposal(p, this.o.store, this.o.conventions, this.chats))
    return redactDeep({ ...d, proposals, metrics: this.chats.metrics(id) }, this.o.redact)
  }

  /** 新建对话（不给 chat）或在对话里接着说。进度经 emit 一行行推出去，最后一行是结果。 */
  async send(body: Record<string, unknown>, emit: (line: ChatStreamLine) => void): Promise<void> {
    if (typeof body.text !== 'string') return emit({ type: 'done', ok: false, error: '需要 text（要说的话）' })
    if (body.chat !== undefined && typeof body.chat !== 'string') return emit({ type: 'done', ok: false, error: 'chat 必须是对话 id' })
    const flow = this.flow(e => {
      const line = streamLine(e)
      if (line !== undefined) emit(line)
    })
    let r
    try {
      r = body.chat === undefined ? await flow.start(body.text, 'web') : await flow.send(body.chat, body.text, 'web')
    } catch (e) {
      // 推送已经开始（响应头发出去了），出错也只能作为最后一行告诉页面。
      return emit({ type: 'done', ok: false, error: `这一轮出错了：${this.o.redact((e as Error).message)}` })
    }
    emit(r.ok ? { type: 'done', ok: true, chat: r.chat.id } : { type: 'done', ok: false, error: r.error, ...(r.chat === undefined ? {} : { chat: r.chat.id }) })
  }

  /** 保存一条提议：和命令行的 eos chat save 同一条路径，操作人记成 web。confirm 是页面上显示的确认码（等于 --allow-permissions）。 */
  save(id: number, body: Record<string, unknown>): SaveOutcome {
    if (body.confirm !== undefined && typeof body.confirm !== 'string') return { ok: false, error: 'confirm 必须是确认码' }
    if (body.note !== undefined && typeof body.note !== 'string') return { ok: false, error: 'note 必须是文字' }
    return saveProposal({
      store: this.o.store,
      chats: this.chats,
      conventions: this.o.conventions,
      redact: this.o.redact,
      id,
      actor: 'web',
      ...(body.confirm === undefined ? {} : { confirm: body.confirm }),
      ...(body.note === undefined ? {} : { note: body.note }),
      now: this.o.now,
    })
  }
}
