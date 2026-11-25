// 工作流的类型：角色（谁来做）与节点（按顺序做什么）。由 parse.ts 从 YAML 解析得到，内部只信任这些类型。

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type RoleId = Brand<string, 'RoleId'>
export type NodeId = Brand<string, 'NodeId'>

export type Effort = 'low' | 'high' | 'max'

/** none：只读；worktree：只能写任务的 git worktree。 */
export type WriteScope = 'none' | 'worktree'

/**
 * 可以从 agent 进程里整组去掉的工具。dsh 只能按插件整组关掉工具，所以按组限制，不按单个工具名：
 * web 联网抓取和搜索；subagent 子 agent 与编排；bash 命令行与后台任务；schedule 定时任务；todo 待办；goal 目标。
 * 读写文件和向用户提问的工具始终保留（写哪些路径由 writePaths 管）。
 */
export const TOOL_GROUPS = ['web', 'subagent', 'bash', 'schedule', 'todo', 'goal'] as const
export type ToolGroup = (typeof TOOL_GROUPS)[number]

/** 用 stdio 启动的 MCP 服务。env 不放密钥（模板以明文保存）。 */
export type McpServer = { name: string; command: string; args: string[]; env: Record<string, string> }

/** agent 的配置：模板和工作流里直接写的角色共用。 */
export type AgentConfig = {
  model: string
  effort?: Effort
  /** 角色的职责说明，作为该角色每个会话的第一段内容。 */
  prompt: string
  write: WriteScope
  /** write 为 worktree 时允许改动的路径（worktree 内的 glob，例如 src/**）；越界的改动会被撤销。 */
  writePaths: string[]
  /** 从 agent 进程里去掉的工具组。 */
  denyTools: ToolGroup[]
  /** agent 能看到的技能（平台上的技能名）；只能看到这些，看不到仓库和用户目录里的技能。 */
  skills: string[]
  mcp: McpServer[]
}

/** 团队级 Agent 模板：平台上维护、带版本，工作流的角色可以直接引用。 */
export type AgentTemplate = AgentConfig & { name: string; description?: string }

export type Role = AgentConfig & {
  id: RoleId
  /** 角色来自哪个模板的哪个版本；工作流里直接写的角色没有。 */
  template?: { name: string; version: number }
}

/** 按名字找模板的最新版本。解析工作流时注入：解析本身保持纯函数。 */
export type TemplateLookup = (name: string) => { template: AgentTemplate; version: number } | undefined

/**
 * 平台替任务做的动作。push：把任务分支推到远程仓库的同名分支（不强推）；
 * pull-request：推送之后，从任务分支向任务的基线分支（远程的默认分支）开 PR，已经有就复用。
 */
export const PLATFORM_ACTIONS = ['push', 'pull-request'] as const
export type PlatformAction = (typeof PLATFORM_ACTIONS)[number]

/**
 * 平台用程序执行的验收检查，不靠模型自评：
 * file：交付物文件存在于 worktree 内，并且包含这些章节（Markdown 标题）；run：命令在 worktree 里执行，退出码为 0；
 * platform：平台替任务做一个动作（例如推送分支），做成了算通过。用到的凭据只在平台进程里，agent 碰不到。
 */
export type Check = { kind: 'file'; path: string; sections: string[] } | { kind: 'run'; run: string[]; timeoutSec: number } | { kind: 'platform'; action: PlatformAction }

/** 一个 agent 完成一段工作，产出文本（方案、开发说明等），并拥有一个跨整个任务的会话。 */
export type AgentNode = {
  kind: 'agent'
  id: NodeId
  role: RoleId
  /** 交给这个 agent 的工作说明。 */
  task: string
  /** 需要读取的上游节点产出。 */
  inputs: NodeId[]
  /** 完成后平台要检查的交付物与命令。不通过就让同一个 agent 补齐，最多 maxFixes 次，之后问用户。 */
  checks: Check[]
  maxFixes: number
}

/**
 * 对话循环：with 节点的 agent 在自己原来的会话里回应，直到这一轮通过。
 * 每一轮先跑 checks（例如测试命令），通过了再由评审方（role，可选）审查；两者至少有一个。
 * maxRounds 轮仍不通过时，交给 escalate 节点重新确认做法和需求；没有 escalate 或已重新确认过，就问用户。
 */
export type DialogNode = {
  kind: 'dialog'
  id: NodeId
  role?: RoleId
  checks: Check[]
  with: NodeId
  escalate?: NodeId
  maxRounds: number
  task: string
  inputs: NodeId[]
}

export type WorkflowNode = AgentNode | DialogNode

export type Workflow = {
  name: string
  description?: string
  /** 要注入给这个工作流里所有 agent 的团队约定文档（平台里的文档名）。 */
  docs: string[]
  roles: Record<string, Role>
  nodes: WorkflowNode[]
}

export const role = (wf: Workflow, id: RoleId): Role => {
  const r = wf.roles[id]
  if (r === undefined) throw new Error(`工作流 ${wf.name} 没有角色 ${id}`)
  return r
}

export const node = (wf: Workflow, id: NodeId): WorkflowNode => {
  const n = wf.nodes.find(x => x.id === id)
  if (n === undefined) throw new Error(`工作流 ${wf.name} 没有节点 ${id}`)
  return n
}
