// 执行器注册表：按名字登记的执行器。平台启动时只建注册表（src/cli.ts），不知道有哪些执行器。
// 注册表本身实现 Executor：send 按 spec.executor 交给对应的执行器，别的方法问每个执行器。所以 runner、对话 agent、改进提案
// 都只认 Executor 接口，角色换执行器时它们不用改。
import type { TraceEvent } from '../trace/types.ts'
import { dsh } from './dsh.ts'
import type { AgentSpec, AskHandler, Executor, ExecutorContext, ExecutorKind, Health, Reply } from './types.ts'

/** 登记的执行器。第一个是默认执行器：角色没有写 executor 时用它。 */
export const EXECUTORS: readonly ExecutorKind[] = [dsh]

/**
 * 按名字分派的执行器。每种执行器第一次用到时才建（没用到的执行器装没装好不影响别的）。
 * 一个会话（key）只在一个执行器里：findReply、traceOf 依次问每个执行器，取第一个有结果的。
 */
export class Executors implements Executor {
  private readonly made = new Map<string, Executor>()

  constructor(
    private readonly ctx: ExecutorContext,
    private readonly kinds: readonly ExecutorKind[] = EXECUTORS,
  ) {
    if (kinds.length === 0) throw new Error('没有登记任何执行器')
    if (new Set(kinds.map(k => k.name)).size !== kinds.length) throw new Error('执行器的名字重复')
  }

  get names(): string[] {
    return this.kinds.map(k => k.name)
  }

  /** 这个名字没有登记时的说明；登记了时 undefined。 */
  unknown(name: string): string | undefined {
    return this.kinds.some(k => k.name === name) ? undefined : `没有名为「${name}」的执行器（可用的：${this.names.join('、')}）`
  }

  private get(name: string): Executor {
    const kind = this.kinds.find(k => k.name === name)
    if (kind === undefined) throw new Error(this.unknown(name))
    let ex = this.made.get(name)
    if (ex === undefined) {
      ex = kind.create(this.ctx)
      this.made.set(name, ex)
    }
    return ex
  }

  /** 能建起来的执行器。建不起来的（例如没装好）里不会有这次要找的会话：跳过，真正要用它时 send 会报出原因。 */
  private all(): Executor[] {
    return this.kinds.flatMap(k => {
      try {
        return [this.get(k.name)]
      } catch {
        return []
      }
    })
  }

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    return this.get(p.spec.executor ?? this.kinds[0]!.name).send(p)
  }

  async findReply(key: string, nonce: string): Promise<Reply | undefined> {
    for (const ex of this.all()) {
      const r = await ex.findReply(key, nonce)
      if (r !== undefined) return r
    }
    return undefined
  }

  async traceOf(key: string, nonce: string): Promise<TraceEvent[]> {
    for (const ex of this.all()) {
      const t = await ex.traceOf(key, nonce)
      if (t.length > 0) return t
    }
    return []
  }

  async release(cwd: string): Promise<void> {
    await Promise.all([...this.made.values()].map(ex => ex.release(cwd)))
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.made.values()].map(ex => ex.close()))
  }
}

/** 每种执行器的自检，按登记的顺序。 */
export const healthOf = (ctx: ExecutorContext, kinds: readonly ExecutorKind[] = EXECUTORS): { name: string; health: Health }[] => kinds.map(k => ({ name: k.name, health: k.health(ctx) }))
