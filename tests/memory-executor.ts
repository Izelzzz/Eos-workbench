// 不调模型的假执行器，按 Executor 接口的约定行事：会话按 key 记在内存里，回复和 trace 按 nonce 找得回来。
// 跨执行器的接口测试（tests/executor-contract.test.ts）把它和真的执行器放在一起跑同一套用例；注册表的测试用它当执行器。
// 和 fake-executor.ts、mcp-executor.ts 的区别：那两个按剧本回复、由测试指定"已有的回复"，给 runner 和对话 agent 的测试用。
import type { AgentSpec, AskHandler, Executor, Reply } from '../src/executor/types.ts'
import type { TraceEvent } from '../src/trace/types.ts'

type Turn = { nonce: string; reply: Reply; trace: TraceEvent[] }

export class MemoryExecutor implements Executor {
  readonly sessions = new Map<string, { id: string; turns: Turn[] }>()
  readonly released: string[] = []
  closed = false
  private n = 0

  constructor(private readonly name = 'memory') {}

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    let s = this.sessions.get(p.key)
    if (s === undefined) {
      s = { id: `${this.name}-${++this.n}`, turns: [] }
      this.sessions.set(p.key, s)
    }
    const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }
    const text = `${this.name}：${p.prompt}`
    const trace: TraceEvent[] = [
      { kind: 'call_start', t: 1 },
      { kind: 'step_start', t: 1, step: 1 },
      { kind: 'model', t: 2, step: 1, usage, reasoning: '', text, toolCalls: [] },
      { kind: 'step_end', t: 3, step: 1 },
    ]
    for (const e of trace.slice(1)) p.onEvent?.(e)
    const reply: Reply = { sessionId: s.id, text, usage, ms: 2, model: p.spec.model }
    s.turns.push({ nonce: p.nonce, reply, trace })
    return reply
  }

  async findReply(key: string, nonce: string): Promise<Reply | undefined> {
    return this.sessions.get(key)?.turns.findLast(t => t.nonce === nonce)?.reply
  }

  async traceOf(key: string, nonce: string): Promise<TraceEvent[]> {
    return this.sessions.get(key)?.turns.findLast(t => t.nonce === nonce)?.trace ?? []
  }

  async release(cwd: string): Promise<void> {
    this.released.push(cwd)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
