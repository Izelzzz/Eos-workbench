// 执行器接口：引擎、runner、对话 agent 只认这个接口。每种执行器在 src/executor/ 下自己的文件里实现它，
// 在 registry.ts 里按名字登记；别的模块不知道有哪些执行器。
import type { ModelKey } from '../credentials/model-key.ts'
import type { Usage } from '../engine/types.ts'
import type { CheckUser } from '../runner/check-user.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { Effort, McpServer, ToolGroup, WriteScope } from '../workflow/types.ts'

/** 角色能看到的一个技能：名字和 SKILL.md 全文（任务创建时的快照，见 store 的 SkillSnapshot）。 */
export type AgentSkill = { name: string; content: string }

/**
 * agent 的能力面：去掉哪些工具组、能看到哪些技能、挂哪些 MCP 服务。
 * 没有"不限制"这种省略写法：能力面是安全边界，每个调用方都要写明白。
 */
/**
 * agent 进程的能力面。background：能不能起后台作业。可写角色不能（Izelzzz/Eos-workbench#28）：
 * 后台进程会活过这一轮，在平台撤销越界改动时把目录换成指向外面的链接，让平台删到 worktree 之外。
 */
/**
 * 平台交给 agent 的 MCP 端点（标准的 Streamable HTTP）。headers 里通常有这次调用的令牌：执行器只把它交给自己连 MCP 的那一侧，
 * 不写进 agent 的工具子进程能读到的环境，用完（release）后不留在执行器自己的配置里。
 */
export type HttpMcp = { name: string; url: string; headers: Record<string, string> }

/** agent 的 MCP 服务：模板里写的本地 stdio 服务，或者平台提供的 HTTP 端点（有 url 的是后者）。 */
export type AgentMcp = McpServer | HttpMcp

export const isHttpMcp = (m: AgentMcp): m is HttpMcp => 'url' in m

/**
 * builtinTools：执行器自带的工具。
 * - 'standard'：执行器自带的文件读写、搜索、技能、向用户提问等工具照常可用，denyTools 去掉其中的整组（任务里的角色）；
 * - 'none'：一个自带工具都没有，agent 只能用 mcp 里平台交给它的工具（例如对话 agent 读平台数据）。denyTools、skills、background 不起作用。
 * 执行器不支持其中某一项（例如没有办法去掉自带工具，或者接不了 HTTP MCP）时，send 必须抛错，不能悄悄忽略。
 */
export type AgentProfile = { builtinTools: 'standard' | 'none'; denyTools: ToolGroup[]; skills: AgentSkill[]; mcp: AgentMcp[]; background: boolean }

/** executor：用哪个执行器（注册表里的名字）；不写时用注册表的默认执行器。model：不写时用那个执行器自己的默认模型。 */
export type AgentSpec = { executor?: string; model?: string; effort?: Effort; write: WriteScope; cwd: string; profile: AgentProfile }

/**
 * 执行器对一个工具组的支持：removable：有，能去掉；absent：本来就没有（角色去掉它等于已经满足）；
 * fixed：有，但去不掉（角色要去掉它时报错，不能悄悄放过）。
 */
export type GroupSupport = 'removable' | 'absent' | 'fixed'

/** 执行器能做到的能力面：每个工具组的支持，以及能不能关掉全部自带工具、关掉后台作业，接不接得了两种 MCP，支不支持技能。 */
export type Capabilities = {
  toolGroups: Record<ToolGroup, GroupSupport>
  noBuiltinTools: boolean
  noBackground: boolean
  httpMcp: boolean
  stdioMcp: boolean
  skills: boolean
}

/** 一个 agent 要求执行器做到的（从能力面算出）。建任务、建对话时用它提前核对，send 时注册表再核对一次。 */
export type AgentNeeds = { builtinTools: 'standard' | 'none'; denyTools: ToolGroup[]; background: boolean; httpMcp: boolean; stdioMcp: boolean; skills: boolean }

export const needsOf = (p: Pick<AgentProfile, 'builtinTools' | 'denyTools' | 'mcp' | 'background'> & { skills: readonly unknown[] }): AgentNeeds => ({
  builtinTools: p.builtinTools,
  denyTools: p.denyTools,
  background: p.background,
  httpMcp: p.mcp.some(isHttpMcp),
  stdioMcp: p.mcp.some(m => !isHttpMcp(m)),
  skills: p.skills.length > 0,
})

/** 执行器做不到的要求（中文，每条一句）；都做得到时是空的。没有自带工具时，工具组、后台作业、技能不起作用，不核对。 */
export const unmet = (name: string, c: Capabilities, n: AgentNeeds): string[] => {
  const out: string[] = []
  if (n.builtinTools === 'none') {
    if (!c.noBuiltinTools) out.push(`执行器「${name}」关不掉自带的工具`)
  } else {
    const fixed = n.denyTools.filter(g => c.toolGroups[g] === 'fixed')
    if (fixed.length > 0) out.push(`执行器「${name}」去不掉工具组 ${fixed.join('、')}`)
    if (!n.background && !c.noBackground) out.push(`执行器「${name}」关不掉后台作业（可写的角色不能起后台作业）`)
    if (n.skills && !c.skills) out.push(`执行器「${name}」不支持技能`)
  }
  if (n.httpMcp && !c.httpMcp) out.push(`执行器「${name}」接不了平台的 HTTP MCP 端点`)
  if (n.stdioMcp && !c.stdioMcp) out.push(`执行器「${name}」接不了 stdio 的 MCP 服务`)
  return out
}

/** 核对一个 agent 能不能交给某个执行器（不写名字时是默认执行器）：能时 undefined，不能时是原因（没登记，或者做不到的要求）。 */
export type ExecutorCheck = (executor: string | undefined, needs: AgentNeeds) => string | undefined

export type Reply = { sessionId: string; text: string; usage: Usage; ms: number; model?: string }

export type AgentQuestion = { id: string; text: string; options?: string[] }

/** agent 在调用中途提问：返回用户的回答；被取消时 signal 触发。 */
export type AskHandler = (q: AgentQuestion, signal: AbortSignal) => Promise<string>

export interface Executor {
  /**
   * 在 key 对应的会话里发一条消息并等它完成。同一个 key 总是同一个会话：第一次创建，之后续接。
   * nonce 写进消息里，供 findReply 认领。
   */
  send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply>
  /**
   * 会话里带这个 nonce 的消息如果已经有完整的回复，返回它；否则返回 undefined（需要重发）。
   * executor：这次调用 send 时 spec.executor 的值（不写是默认执行器）。注册表据此交给那个执行器；单个执行器不用它。
   */
  findReply(key: string, nonce: string, executor?: string): Promise<Reply | undefined>
  /** 从会话日志里回放这次调用的 trace；运行时没有记录事件流的调用（例如崩溃后找回的）用它补上。executor 同 findReply。 */
  traceOf(key: string, nonce: string, executor?: string): Promise<TraceEvent[]>
  /** 释放这个工作目录占用的资源（例如 agent 进程）。任务的 runner 结束时调用；之后的调用照常可用。 */
  release(cwd: string): Promise<void>
  close(): Promise<void>
}

/** 启动检查（eos doctor）的一项。ok：满足；warn：不满足但可能还能跑，只提示；fail：缺了一定跑不起来，启动前拦下。 */
export type HealthStatus = 'ok' | 'warn' | 'fail'
/** doctorOnly：只在 eos doctor 里列出，启动前检查不提示（总会出现的 ⚠ 会让人习惯性忽略真正的提示）。 */
export type HealthItem = { name: string; status: HealthStatus; detail: string; fix?: string; doctorOnly?: true }

/**
 * 执行器的自检：装没装、版本、沙箱、凭据是否就绪。
 * sandboxed：agent 在沙箱里（平台的「凭据隔离」一项要用）。
 * agentUser：设置了 agent 的用户时，这个执行器能不能真的以那个用户运行 agent（不能时是原因）；没设置时不看。
 */
export type Health = { items: HealthItem[]; sandboxed: boolean; agentUser?: string }

/**
 * 执行器要的模型 key：凭据存储里的名字、平台启动时从环境变量里取走的变量名、在 doctor 里显示的名字。
 * 平台按这个声明取 key、交给执行器；key 怎么交给执行器自己的进程（环境变量、配置）由执行器决定。
 */
export type ModelKeySpec = { credential: string; env: string; label: string }

/** 平台交给执行器的环境：建执行器和自检都只用这些。 */
export type ExecutorContext = {
  /** Eos 的安装目录（package.json、node_modules 所在）。 */
  root: string
  dataDir: string
  env: NodeJS.ProcessEnv
  /** 这个执行器声明的模型 key 现在的来源和值（凭据存储优先，环境变量其次）：每次取都重新读，在 Web 上换了 key 之后取到的是新的。 */
  modelKey: () => ModelKey
  /** 平台的凭据存储能不能存取凭据（设置了有效的主密钥）。不能时，自检里说清凭据存储里为什么没有执行器要的 key。 */
  credentialsUsable: boolean
  /** agent 用的系统用户（部署镜像里设置）；没有设置时 undefined。 */
  agentUser?: CheckUser
}

/** 注册表里的一种执行器：名字、能做到的能力面、要的模型 key、怎么建、怎么自检。 */
export type ExecutorKind = {
  name: string
  capabilities: Capabilities
  modelKey: ModelKeySpec
  create(ctx: ExecutorContext): Executor
  health(ctx: ExecutorContext): Health
}
