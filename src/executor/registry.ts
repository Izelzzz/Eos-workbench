// 执行器注册表：按名字登记的执行器。平台启动时只建注册表（src/cli.ts），不知道有哪些执行器。
// 注册表本身实现 Executor：send 按 spec.executor、findReply 和 traceOf 按调用方给的执行器名字交给对应的执行器，
// release、close 交给建出来的每个执行器。所以 runner、对话 agent、改进提案都只认 Executor 接口，角色换执行器时它们不用改。
import type { TraceEvent } from '../trace/types.ts'
import { dsh } from './dsh.ts'
import type { AgentNeeds, AgentSpec, AskHandler, Executor, ExecutorContext, ExecutorKind, Health, ModelKeySpec, Reply } from './types.ts'
import { needsOf, unmet } from './types.ts'

/** 登记的执行器。第一个是默认执行器：角色没有写 executor 时用它。 */
export const EXECUTORS: readonly ExecutorKind[] = [dsh]

/** 平台给每种执行器的环境：每种执行器要的模型 key 不一样（ExecutorKind.modelKey）。 */
export type ContextFor = (kind: ExecutorKind) => ExecutorContext

/** 登记的执行器要的模型 key（去掉重复的）：平台启动时按这些从环境变量里取走 key。 */
export const modelKeySpecs = (kinds: readonly ExecutorKind[] = EXECUTORS): ModelKeySpec[] => [...new Map(kinds.map(k => [k.modelKey.env, k.modelKey])).values()]

const unknown = (name: string, kinds: readonly ExecutorKind[]): string => `没有名为「${name}」的执行器（可用的：${kinds.map(k => k.name).join('、')}）`

/**
 * 核对一个 agent 能不能交给这个执行器（不写名字时是默认执行器）：能时 undefined；不能时是原因——没登记，或者执行器做不到的要求（Capabilities）。
 * 模板和工作流写的 executor、角色的能力面在创建任务、建对话时用它核对；send 时再核对一次。
 */
export const checkExecutor = (name: string | undefined, needs: AgentNeeds, kinds: readonly ExecutorKind[] = EXECUTORS): string | undefined => {
  const kind = name === undefined ? kinds[0] : kinds.find(k => k.name === name)
  if (kind === undefined) return unknown(name ?? '', kinds)
  const problems = unmet(kind.name, kind.capabilities, needs)
  return problems.length === 0 ? undefined : problems.join('；')
}

/**
 * 按名字分派的执行器。每种执行器第一次用到时才建（没用到的执行器装没装好不影响别的）。
 * 不写名字时用默认执行器（登记的第一个）：角色没写 executor 的调用、本来就没有记录执行器的旧任务和旧对话都走它。
 */
export class Executors implements Executor {
  private readonly made = new Map<string, Executor>()

  constructor(
    private readonly ctxFor: ContextFor,
    private readonly kinds: readonly ExecutorKind[] = EXECUTORS,
  ) {
    if (kinds.length === 0) throw new Error('没有登记任何执行器')
    if (new Set(kinds.map(k => k.name)).size !== kinds.length) throw new Error('执行器的名字重复')
  }

  private get default(): string {
    return this.kinds[0]!.name
  }

  private get(name: string): Executor {
    const kind = this.kinds.find(k => k.name === name)
    if (kind === undefined) throw new Error(unknown(name, this.kinds))
    let ex = this.made.get(name)
    if (ex === undefined) {
      ex = kind.create(this.ctxFor(kind))
      this.made.set(name, ex)
    }
    return ex
  }

  /** 执行器做不到这次调用的能力面时直接报错，不交给它（执行器自己也不该悄悄忽略，这里是兜底）。 */
  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    const name = p.spec.executor ?? this.default
    const problem = checkExecutor(name, needsOf(p.spec.profile), this.kinds)
    if (problem !== undefined) throw new Error(problem)
    return this.get(name).send(p)
  }

  /** 找回一次调用：只问那次调用用的执行器（建不起来时报出原因，不当成没有回复）。 */
  async findReply(key: string, nonce: string, executor?: string): Promise<Reply | undefined> {
    return this.get(executor ?? this.default).findReply(key, nonce)
  }

  async traceOf(key: string, nonce: string, executor?: string): Promise<TraceEvent[]> {
    return this.get(executor ?? this.default).traceOf(key, nonce)
  }

  async release(cwd: string): Promise<void> {
    await Promise.all([...this.made.values()].map(ex => ex.release(cwd)))
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.made.values()].map(ex => ex.close()))
  }
}

/** 每种执行器的自检，按登记的顺序。 */
export const healthOf = (ctxFor: ContextFor, kinds: readonly ExecutorKind[] = EXECUTORS): { name: string; health: Health }[] => kinds.map(k => ({ name: k.name, health: k.health(ctxFor(k)) }))
