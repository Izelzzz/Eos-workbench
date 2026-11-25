import type { AskHandler, Executor, Reply } from '../src/executor/types.ts'
import type { TraceEvent } from '../src/trace/types.ts'

export type Script = (p: { key: string; prompt: string; nonce: string; ask: AskHandler }) => Promise<string>

/** 假执行器：按剧本回复；completed 模拟"会话日志里已经有的回复"。 */
export class FakeExecutor implements Executor {
  sent: string[] = []
  completed = new Map<string, Reply>()
  constructor(private readonly script: Script) {}
  async send(p: { key: string; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    this.sent.push(p.nonce)
    p.onEvent?.({ kind: 'step_start', t: 10, step: 1 })
    const text = await this.script(p)
    p.onEvent?.({ kind: 'step_end', t: 20, step: 1 })
    return { sessionId: `s:${p.key}`, text, usage: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 0 }, ms: 50, model: 'deepseek-flash' }
  }
  async findReply(_key: string, nonce: string) {
    return this.completed.get(nonce)
  }
  async traceOf() {
    return [
      { kind: 'call_start' as const, t: 1 },
      { kind: 'step_start' as const, t: 2, step: 1 },
    ]
  }
  released: string[] = []
  async release(cwd: string) {
    this.released.push(cwd)
  }
  async close() {}
}
