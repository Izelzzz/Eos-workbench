// dsh 原生 agent 执行器。唯一引用 dsh 的模块。
// - 每种模型路由（model + effort）一个 dsh 进程，同一路由的会话共用它。
// - 会话 id 由 key 确定性地算出，进程崩溃后总能找回同一个会话。
// - 新会话先设工作目录和权限档位（只读 / 只写工作区），再发第一条消息。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { Usage } from '../engine/types.ts'
import { zeroUsage } from '../engine/types.ts'
import type { DeepSeekHarness as Harness, HarnessSession } from '../../vendor/dsh-sdk-client/index.ts'
import { DeepSeekHarness } from '../../vendor/dsh-sdk-client/index.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { AgentQuestion, AgentSpec, AskHandler, Executor, Reply } from './types.ts'

export const PROVIDER = 'deepseek-official'
const PRESET: Record<AgentSpec['write'], string> = { none: 'read-only', worktree: 'workspace-write' }

type LogEvent = { type: string; time: number; data?: Record<string, any> }

const marker = (nonce: string) => `<!-- eos:${nonce} -->`

/**
 * 交给 dsh 进程的环境。宿主机用 GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n 注入 git 配置时，
 * dsh 会把名字像凭据的 GIT_CONFIG_KEY_n 清掉、留下另外两组，agent 沙箱里的 git 就全部报
 * "missing config key"。三组一起去掉：agent 的 shell 不需要宿主机注入的 git 配置。
 */
export const agentEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(k)))

export const sessionIdFor = (key: string): string => `session-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`

const usageOf = (events: LogEvent[]): Usage =>
  events.filter(e => e.type === 'assistant/message').reduce((u, e) => {
    const x = e.data?.usage ?? e.data?.message?.usage
    if (x === undefined) return u
    return { input: u.input + (x.inputTokens ?? 0), output: u.output + (x.outputTokens ?? 0), cacheRead: u.cacheRead + (x.cacheReadTokens ?? 0), cacheWrite: u.cacheWrite + (x.cacheWriteTokens ?? 0) }
  }, zeroUsage())

const textOf = (e: LogEvent): string => {
  const content = (e.data?.message?.content ?? e.data?.content ?? []) as { type: string; text?: string }[]
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

const contentOf = (e: LogEvent) => (e.data?.message?.content ?? e.data?.content ?? []) as { type: string; text?: string; id?: string; name?: string; arguments?: string }[]

/** dsh 事件 → 平台的 TraceEvent。实时推送的事件和磁盘日志里的事件结构相同，都走这里；不关心的类型返回 undefined。 */
export const normalize = (e: LogEvent): TraceEvent | undefined => {
  const step = Number(e.data?.step ?? 0)
  switch (e.type) {
    case 'step/start':
      return { kind: 'step_start', t: e.time, step }
    case 'step/end':
      return { kind: 'step_end', t: e.time, step }
    case 'assistant/message': {
      const c = contentOf(e)
      const model = e.data?.message?.source?.model
      return {
        kind: 'model', t: e.time, step, usage: usageOf([e]), ...(model === undefined ? {} : { model }),
        reasoning: c.filter(x => x.type === 'reasoning').map(x => x.text ?? '').join(''),
        text: c.filter(x => x.type === 'text').map(x => x.text ?? '').join(''),
        toolCalls: c.filter(x => x.type === 'tool-call').map(x => ({ id: String(x.id), name: String(x.name), args: String(x.arguments ?? '') })),
      }
    }
    case 'tool/call':
      return { kind: 'tool_start', t: e.time, step, id: String(e.data?.callId), name: String(e.data?.name), args: String(e.data?.arguments ?? '') }
    case 'tool/result':
      return { kind: 'tool_end', t: e.time, id: String(e.data?.message?.toolCallId), output: contentOf(e).map(x => x.text ?? '').join(''), isError: e.data?.message?.isError === true }
    default:
      return undefined
  }
}

const modelOf = (events: LogEvent[]): string | undefined =>
  events.filter(e => e.type === 'assistant/message').map(e => e.data?.message?.source?.model).filter(Boolean).at(-1)

const MARKED = /<!-- eos:[^ ]+ -->/

/**
 * 带 nonce 的那条用户消息之后的回复。一次调用可能跨多个 turn（agent 等后台命令时，命令结束会再起一个 turn），
 * 所以一直看到下一条带 nonce 的消息（或日志末尾）为止，并要求最后一个 turn 已经结束；否则说明那次调用没做完。
 */
/** 带 nonce 的那条消息到下一条带 nonce 的消息之间的事件（不含两端）。 */
const rangeOf = (events: LogEvent[], nonce: string): { start: number; range: LogEvent[] } | undefined => {
  const start = events.findLastIndex(e => e.type === 'user/message' && textOf(e).includes(marker(nonce)))
  if (start < 0) return undefined
  const rest = events.slice(start + 1)
  const next = rest.findIndex(e => e.type === 'user/message' && MARKED.test(textOf(e)))
  return { start, range: next < 0 ? rest : rest.slice(0, next) }
}

/** 一次调用在会话日志里的 trace（给运行时没有记录事件流的调用回放用）。 */
export const traceAfter = (events: LogEvent[], nonce: string): TraceEvent[] => {
  const found = rangeOf(events, nonce)
  if (found === undefined) return []
  // dsh 先开始一轮和第一步，再把这条消息插进去：从这一轮的 turn/start 起算，补上排在消息前面的第一个 step/start。
  const turn = events.slice(0, found.start).findLastIndex(e => e.type === 'turn/start' || e.type === 'turn/end')
  const head = turn >= 0 && events[turn]!.type === 'turn/start' ? events.slice(turn, found.start) : []
  const t = head[0]?.time ?? events[found.start]!.time
  const lead = head.filter(e => e.type === 'step/start')
  return [{ kind: 'call_start', t }, ...[...lead, ...found.range].map(normalize).filter((x): x is TraceEvent => x !== undefined)]
}

/**
 * 一轮结束的原因算不算这次调用完成：completed 算；max-tokens 也算——dsh 只要某一步达到过输出上限就记成 max-tokens，
 * 即使之后这一轮正常写完了，dsh 的 SDK 默认也把它当成功。被打断、出错、中止、被拦下的都不算。
 */
const DONE = new Set(['completed', 'max-tokens'])

const REASON: Record<string, string> = { interrupted: '被打断', error: '出错', aborted: '被中止', blocked: '被拦下' }

export const describeEnd = (kind: string | null | undefined): string => REASON[kind ?? ''] ?? `结束原因为 ${kind ?? '未知'}`

export type TurnOutcome = { ok: true } | { ok: false; error: string }

/** 实时调用（send）和从日志认领（replyAfter）共用的判断。 */
export const turnOutcome = (kind: string | null | undefined, finalText = ''): TurnOutcome =>
  DONE.has(kind ?? '') ? { ok: true } : { ok: false, error: `这一轮没有正常完成（${describeEnd(kind)}）${finalText ? `：${finalText.slice(0, 200)}` : ''}` }

/**
 * 认领一次已完成的调用：最后一轮必须正常完成（见 turnOutcome）。
 * 被打断或出错的那一轮里可能有一句中间文本（例如"我先看一下目录"），不能把它当成这次调用的回复。
 */
export const replyAfter = (events: LogEvent[], nonce: string, sessionId: string): Reply | undefined => {
  const found = rangeOf(events, nonce)
  if (found === undefined) return undefined
  const { start, range } = found
  const end = range.findLastIndex(e => e.type === 'turn/end')
  if (end < 0 || range.slice(end + 1).some(e => e.type === 'turn/start')) return undefined
  if (!turnOutcome(range[end]!.data?.reason?.kind).ok) return undefined
  const turn = range.slice(0, end + 1)
  const final = turn.filter(e => e.type === 'assistant/message').map(textOf).filter(t => t.trim() !== '').at(-1)
  if (final === undefined) return undefined
  const model = modelOf(turn)
  return { sessionId, text: final, usage: usageOf(turn), ms: turn.at(-1)!.time - events[start]!.time, ...(model === undefined ? {} : { model }) }
}

export class DshExecutor implements Executor {
  private readonly harnesses = new Map<string, Harness>()
  /** 本进程里已经打开（新建或续接）的会话。 */
  private readonly open = new Map<string, HarnessSession>()
  private readonly asks = new Map<string, AskHandler>()

  constructor(private readonly opts: { dshHome: string; dshBin: string; env?: NodeJS.ProcessEnv }) {}

  private harness(spec: AgentSpec): Harness {
    const route = `${spec.model}|${spec.effort ?? ''}`
    let h = this.harnesses.get(route)
    if (h === undefined) {
      h = new DeepSeekHarness({
        profile: 'sdk', dshHome: this.opts.dshHome, dshBin: this.opts.dshBin, provider: PROVIDER, model: spec.model,
        ...(spec.effort === undefined ? {} : { reasoningEffort: spec.effort as never }),
        env: agentEnv(this.opts.env ?? process.env),
        initializeTimeoutMs: 60_000,
        onUserQuestion: async (req, { signal }) => this.answer(req.sessionId, req.questions, signal),
      })
      this.harnesses.set(route, h)
    }
    return h
  }

  private async answer(sessionId: string, questions: { id: string; question: string; options?: { label: string }[] }[], signal: AbortSignal) {
    const ask = this.asks.get(sessionId)
    if (ask === undefined) return { cancelled: true as const }
    const answers = []
    for (const q of questions) {
      const options = q.options?.map(o => o.label)
      const text = await ask({ id: q.id, text: q.question, ...(options === undefined ? {} : { options }) } satisfies AgentQuestion, signal)
      const picked = options?.find(o => o === text.trim())
      answers.push(picked === undefined ? { id: q.id, selected: [], custom: text } : { id: q.id, selected: [picked] })
    }
    return { answers }
  }

  private logFile(sessionId: string): string | undefined {
    const root = join(this.opts.dshHome, 'sessions')
    if (!existsSync(root)) return undefined
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
      if (existsSync(file)) return file
    }
    return undefined
  }

  private readLog(sessionId: string): LogEvent[] | undefined {
    const file = this.logFile(sessionId)
    if (file === undefined) return undefined
    try {
      return zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as LogEvent)
    } catch {
      // 进程被杀在写入中途：日志尾部不完整，按"没有回复"处理，重发这一轮。
      return undefined
    }
  }

  private async session(key: string, spec: AgentSpec): Promise<HarnessSession> {
    const id = sessionIdFor(key)
    const known = this.open.get(id)
    if (known !== undefined) return known
    const h = this.harness(spec)
    let s: HarnessSession
    if (this.logFile(id) !== undefined) {
      s = await h.resumeSession(id)
    } else {
      s = h.session(id)
      await s.setWorkingDirectory(spec.cwd)
    }
    // 新建和续接都要设：会话在设工作目录时就已落盘（默认可写），进程若死在切换档位之前，
    // 续接回来的只读角色会带着写权限。重复选择当前档位在 dsh 里不产生变化。
    const set = await s.run(`/permission ${PRESET[spec.write]}`)
    if (set.finishReason === 'error') throw new Error(`设置权限档位失败：${set.finalResponse}`)
    this.open.set(id, s)
    return s
  }

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    const s = await this.session(p.key, p.spec)
    this.asks.set(s.id, p.ask)
    const started = Date.now()
    try {
      const r = await s.run(`${p.prompt}\n\n${marker(p.nonce)}`, {
        onNotification: n => {
          if (n.method !== 'session.event' || n.params.sessionId !== s.id || p.onEvent === undefined) return
          const e = normalize(n.params.event as LogEvent)
          if (e !== undefined) p.onEvent(e)
        },
      })
      const outcome = turnOutcome(r.finishReason, r.finalResponse)
      if (!outcome.ok) throw new Error(outcome.error)
      const events = r.events as unknown as LogEvent[]
      const model = modelOf(events)
      return { sessionId: s.id, text: r.finalResponse, usage: usageOf(events), ms: Date.now() - started, ...(model === undefined ? {} : { model }) }
    } finally {
      this.asks.delete(s.id)
    }
  }

  async findReply(key: string, nonce: string): Promise<Reply | undefined> {
    const id = sessionIdFor(key)
    const events = this.readLog(id)
    return events === undefined ? undefined : replyAfter(events, nonce, id)
  }

  async traceOf(key: string, nonce: string): Promise<TraceEvent[]> {
    const events = this.readLog(sessionIdFor(key))
    return events === undefined ? [] : traceAfter(events, nonce)
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.harnesses.values()].map(h => h.close()))
    this.harnesses.clear()
    this.open.clear()
  }
}
