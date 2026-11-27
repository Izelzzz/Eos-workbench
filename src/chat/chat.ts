// 对话 agent：不绑定任务，可以多轮对话。只认 Executor 接口和 AgentProfile，不依赖某一个执行器。
// - 能力面由平台定死：没有执行器自带的任何工具（builtinTools: 'none'），只读平台数据的工具经这次调用的 MCP 端点（mcp.ts）交给它；
//   模板（内置的 assistant，团队可以改）只提供执行器、模型、effort 和提示词，改模板放不开权限。
// - 每说一句话是一次调用：开一个新的 MCP 端点（新端口、新令牌），调用结束就关掉，并让执行器释放资源。
// - 对话记录、trace、用量存在自己的表里（store.ts），平台重启后接着聊；执行器那一侧的会话按对话 id 续接。
// - 平台重启时一句话的调用可能没做完：下次说话前先向执行器认领那次调用的回复，认领不到记一条「没有得到回复」。
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Conventions } from '../conventions/conventions.ts'
import { redactDeep } from '../credentials/redact.ts'
import type { Executor, Reply } from '../executor/types.ts'
import { acquire } from '../runner/lock.ts'
import type { TraceEvent } from '../trace/types.ts'
import { TOOL_GROUPS } from '../workflow/types.ts'
import { openEndpoint } from './mcp.ts'
import type { ChatStore } from './store.ts'
import { PROPOSE_TOOL, proposer, proposeToolSpec } from './proposals.ts'
import { callTool, type DataSource, toolList, TOOLS } from './tools.ts'
import type { ChatActor, ChatCall, ChatDetail, ChatRead, ChatSummary } from './types.ts'
import { ASSISTANT_TEMPLATE } from './types.ts'

export const ASSISTANT = ASSISTANT_TEMPLATE
/** MCP 服务名：agent 看到的工具名里会带上它（各执行器的写法不同）。 */
export const MCP_NAME = 'eos'
export const MAX_MESSAGE_CHARS = 20_000

export type ChatFailure = 'input' | 'busy' | 'config' | 'upstream'
export type SendResult = { ok: true; chat: ChatSummary; reply: string; call: ChatCall } | { ok: false; cause: ChatFailure; error: string; chat?: ChatSummary }

export type ChatOptions = {
  chats: ChatStore
  data: DataSource
  conventions: Conventions
  executor: Executor
  dataDir: string
  redact: (s: string) => string
  now: () => number
  /** 每个 trace 事件到达时（已遮蔽）：命令行用它显示进度，网页用它边生成边显示。 */
  onEvent?: (chatId: string, e: TraceEvent) => void
}

const keyOf = (id: string) => `chat/${id}`
const nonceOf = (id: string, seq: number) => `chat/${id}/${seq}`

/** 一次调用是对话里哪一句用户的话引起的（nonceOf 的反过来）：save.ts 用它核对那一轮已经有了回复。 */
export const turnOf = (call: string): { chat: string; seq: number } | undefined => {
  const m = /^chat\/([^/]+)\/(\d+)$/.exec(call)
  return m === null ? undefined : { chat: m[1]!, seq: Number(m[2]) }
}

/**
 * 执行器报告的工具名 → 平台工具的名字；不是平台的只读工具时 undefined。执行器可能给 MCP 工具加前缀（例如 mcp__eos__list_tasks），所以按结尾认。
 * 执行了别的工具，说明执行器没有按 builtinTools: 'none' 去掉自带工具：这一轮作废（失败就关）。
 */
const OURS = [...TOOLS.map(t => t.name), PROPOSE_TOOL]
export const ours = (name: string): string | undefined => OURS.find(t => name === t || name.endsWith(`__${t}`))

/** 这次调用执行了的工具里，不是平台只读工具的那些（只看真正执行了的 tool_start；模型要了但执行器没有的工具不算）。 */
const foreignIn = (events: TraceEvent[]): string[] => [...new Set(events.flatMap(e => (e.kind === 'tool_start' && ours(e.name) === undefined ? [e.name] : [])))]

/** 记下的工具参数最多 500 字。调用方先遮蔽再截断：截断处的半截凭据遮蔽认不出来。 */
const cutArgs = (args: string): string => args.slice(0, 500)

/** trace 里的工具调用 → agent 读了哪些数据（认领回来的调用没有端点的记录，从 trace 里还原；工具名和端点记的一样，不带前缀）。 */
const readsIn = (events: TraceEvent[]): ChatRead[] => {
  const failed = new Set(events.flatMap(e => (e.kind === 'tool_end' && e.isError ? [e.id] : [])))
  return events.flatMap(e => (e.kind === 'tool_start' ? [{ tool: ours(e.name) ?? e.name, args: cutArgs(e.args), isError: failed.has(e.id) }] : []))
}

export class Chats {
  constructor(private readonly o: ChatOptions) {}

  list(): ChatSummary[] {
    return this.o.chats.list()
  }

  detail(id: string): ChatDetail | undefined {
    return this.o.chats.detail(id)
  }

  /** 新建一个对话并发第一句话。 */
  async start(text: string, actor: ChatActor): Promise<SendResult> {
    const bad = this.invalid(text)
    if (bad !== undefined) return { ok: false, cause: 'input', error: bad }
    const id = `c${this.o.now().toString(36)}${randomBytes(4).toString('hex')}`
    this.o.chats.create({ id, firstMessage: this.o.redact(text), actor }, this.o.now())
    return this.send(id, text, actor)
  }

  async send(id: string, text: string, actor: ChatActor): Promise<SendResult> {
    const chat = this.o.chats.summary(id)
    if (chat === undefined) return { ok: false, cause: 'input', error: `没有对话 ${id}` }
    const bad = this.invalid(text)
    if (bad !== undefined) return { ok: false, cause: 'input', error: bad, chat }
    const t = this.o.conventions.lookup()(ASSISTANT)
    if (t === undefined) return { ok: false, cause: 'config', error: `平台上没有可用的 Agent 模板「${ASSISTANT}」`, chat }
    // 同一个对话同一时间只有一次调用（网页和命令行共用这把锁）：执行器的会话不能同时收两句话。
    const lock = acquire(join(this.o.dataDir, 'locks'), `chat-${id}`)
    if ('heldBy' in lock) return { ok: false, cause: 'busy', error: `这个对话正在回复上一句（进程 ${lock.heldBy}），等它结束再发`, chat }
    try {
      await this.recover(id)
      const log = this.o.chats.log(id)
      const first = !log.some(m => m.role === 'assistant')
      const seq = this.o.chats.append(id, { at: this.o.now(), role: 'user', text: this.o.redact(text), actor })
      // 还没有回复过的对话（第一句，或者之前每一句都失败了）带上角色说明；之后执行器按 key 续接同一个会话，不再重复。
      const prompt = first ? `${t.template.prompt.trimEnd()}\n\n# 用户说\n\n${text}` : text
      return await this.call(id, seq, prompt, {
        ...(t.template.executor === undefined ? {} : { executor: t.template.executor }),
        model: t.template.model,
        ...(t.template.effort === undefined ? {} : { effort: t.template.effort }),
      })
    } finally {
      lock.release()
    }
  }

  private invalid(text: string): string | undefined {
    if (text.trim() === '') return '消息不能为空'
    if (text.length > MAX_MESSAGE_CHARS) return `消息太长（${text.length} 字），最多 ${MAX_MESSAGE_CHARS} 字`
    return undefined
  }

  private async call(id: string, seq: number, prompt: string, route: { executor?: string; model: string; effort?: 'low' | 'high' | 'max' }): Promise<SendResult> {
    const { chats, redact } = this.o
    const nonce = nonceOf(id, seq)
    const cwd = join(this.o.dataDir, 'chat', id)
    mkdirSync(cwd, { recursive: true })
    // 提议工具只写提议表（待确认），不写约定；其余工具只读。
    const { store } = this.o.data
    const conventions = this.o.conventions
    const propose = proposer({
      conventions: { current: (kind, name) => store.convention(kind, name), validate: (kind, name, content) => conventions.validate(kind, name, content), lookup: () => conventions.lookup() },
      record: (p, at) => chats.addProposal(p, at),
      redact,
      chatId: id,
      call: nonce,
      now: this.o.now,
    })
    const endpoint = await openEndpoint({
      name: MCP_NAME,
      tools: [...toolList(), proposeToolSpec()],
      call: (name, args) => (name === PROPOSE_TOOL ? propose(args) : callTool(this.o.data, redact, name, args)),
    })
    const events: TraceEvent[] = []
    chats.appendTrace(id, nonce, [{ kind: 'call_start', t: this.o.now() }])
    let reply: Reply
    try {
      reply = await this.o.executor.send({
        key: keyOf(id),
        nonce,
        prompt,
        spec: {
          ...route,
          write: 'none',
          cwd,
          profile: { builtinTools: 'none', denyTools: [...TOOL_GROUPS], skills: [], mcp: [endpoint.mcp], background: false },
        },
        ask: async () => '不能向用户提问：请直接回答，信息不够时在回答里说明还需要什么。',
        onEvent: raw => {
          const e = redactDeep(raw, redact)
          events.push(e)
          chats.appendTrace(id, nonce, [e])
          this.o.onEvent?.(id, e)
        },
      })
    } catch (e) {
      return this.failed(id, nonce, `调用失败：${redact((e as Error).message)}`)
    } finally {
      await endpoint.close()
      await this.o.executor.release(cwd).catch(() => undefined)
    }
    const foreign = foreignIn(events)
    if (foreign.length > 0) {
      const reason = `agent 调用了平台工具以外的工具（${foreign.join('、')}），这一轮作废`
      return this.failed(id, nonce, reason)
    }
    return this.succeeded(id, reply, endpoint.reads())
  }

  private succeeded(id: string, reply: Reply, reads: ChatRead[]): SendResult {
    // 工具参数是模型给的原文（可能抄了用户贴进来的 key），存下来之前遮蔽。
    const call: ChatCall = { ...(reply.model === undefined ? {} : { model: reply.model }), usage: reply.usage, ms: reply.ms, reads: reads.map(r => ({ ...r, args: cutArgs(this.o.redact(r.args)) })) }
    const text = this.o.redact(reply.text)
    this.o.chats.append(id, { at: this.o.now(), role: 'assistant', text, call })
    return { ok: true, chat: this.o.chats.summary(id)!, reply: text, call }
  }

  /** 这一轮没有得到回复：记下原因，这一轮的提议跟着作废（用户没看到 agent 对它们的说明，不能拿去保存）。 */
  private failed(id: string, call: string, error: string): SendResult {
    this.o.chats.voidProposals(call, error)
    this.o.chats.append(id, { at: this.o.now(), role: 'error', text: error })
    return { ok: false, cause: 'upstream', error, chat: this.o.chats.summary(id)! }
  }

  /** 最后一条是用户的话、后面没有结果：那次调用没做完（平台重启或进程被杀）。向执行器认领回复，认领不到就记下来。 */
  private async recover(id: string): Promise<void> {
    const last = this.o.chats.log(id).at(-1)
    if (last?.role !== 'user') return
    const nonce = nonceOf(id, last.seq)
    const found = await this.o.executor.findReply(keyOf(id), nonce).catch(() => undefined)
    if (found === undefined) {
      const reason = '这一句没有得到回复：调用没有做完（可能是平台重启了），可以再说一次'
      this.o.chats.voidProposals(nonce, reason)
      this.o.chats.append(id, { at: this.o.now(), role: 'error', text: reason })
      return
    }
    const events = redactDeep(await this.o.executor.traceOf(keyOf(id), nonce).catch(() => []), this.o.redact)
    // 运行时已经记下的事件不重复写（进程是在调用中途死的，事件流可能已经记了一部分；只在一条都没有时补上回放的）。
    if (!this.o.chats.trace(id).some(r => r.call === nonce && r.event.kind !== 'call_start')) this.o.chats.appendTrace(id, nonce, events)
    const foreign = foreignIn(events)
    if (foreign.length > 0) {
      const reason = `agent 调用了平台工具以外的工具（${foreign.join('、')}），这一轮作废`
      this.o.chats.voidProposals(nonce, reason)
      this.o.chats.append(id, { at: this.o.now(), role: 'error', text: reason })
      return
    }
    this.succeeded(id, found, readsIn(events))
  }
}
