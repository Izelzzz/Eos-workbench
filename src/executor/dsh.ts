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
import type { AgentQuestion, AgentSpec, AskHandler, Executor, Reply } from './types.ts'

export const PROVIDER = 'deepseek-official'
const PRESET: Record<AgentSpec['write'], string> = { none: 'read-only', worktree: 'workspace-write' }

type LogEvent = { type: string; time: number; data?: Record<string, any> }

const marker = (nonce: string) => `<!-- eos:${nonce} -->`

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

const modelOf = (events: LogEvent[]): string | undefined =>
  events.filter(e => e.type === 'assistant/message').map(e => e.data?.message?.source?.model).filter(Boolean).at(-1)

/** 带 nonce 的那条用户消息之后、到 turn/end 为止的回复；没有 turn/end 说明那一轮没做完。 */
export const replyAfter = (events: LogEvent[], nonce: string, sessionId: string): Reply | undefined => {
  const start = events.findLastIndex(e => e.type === 'user/message' && textOf(e).includes(marker(nonce)))
  if (start < 0) return undefined
  const rest = events.slice(start + 1)
  const end = rest.findIndex(e => e.type === 'turn/end')
  if (end < 0) return undefined
  const turn = rest.slice(0, end + 1)
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
        ...(this.opts.env === undefined ? {} : { env: this.opts.env }),
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
      const set = await s.run(`/permission ${PRESET[spec.write]}`)
      if (set.finishReason === 'error') throw new Error(`设置权限档位失败：${set.finalResponse}`)
    }
    this.open.set(id, s)
    return s
  }

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler }): Promise<Reply> {
    const s = await this.session(p.key, p.spec)
    this.asks.set(s.id, p.ask)
    const started = Date.now()
    try {
      const r = await s.run(`${p.prompt}\n\n${marker(p.nonce)}`)
      if (r.finishReason === 'error') throw new Error(r.finalResponse || 'dsh 返回错误')
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

  async close(): Promise<void> {
    await Promise.allSettled([...this.harnesses.values()].map(h => h.close()))
    this.harnesses.clear()
    this.open.clear()
  }
}
