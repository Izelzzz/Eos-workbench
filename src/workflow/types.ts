// 工作流的类型：角色（谁来做）与节点（按顺序做什么）。由 parse.ts 从 YAML 解析得到，内部只信任这些类型。

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type RoleId = Brand<string, 'RoleId'>
export type NodeId = Brand<string, 'NodeId'>

export type Effort = 'low' | 'high' | 'max'

/** none：只读；worktree：只能写任务的 git worktree。 */
export type WriteScope = 'none' | 'worktree'

export type Role = {
  id: RoleId
  model: string
  effort?: Effort
  /** 角色的职责说明，作为该角色每个会话的第一段内容。 */
  prompt: string
  write: WriteScope
  /** M3 生效；M1 只做解析和保存。 */
  tools?: string[]
  skills?: string[]
}

/**
 * 平台用程序执行的验收检查，不靠模型自评：
 * file：交付物文件存在于 worktree 内，并且包含这些章节（Markdown 标题）；run：命令在 worktree 里执行，退出码为 0。
 */
export type Check =
  | { kind: 'file'; path: string; sections: string[] }
  | { kind: 'run'; run: string[]; timeoutSec: number }

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
