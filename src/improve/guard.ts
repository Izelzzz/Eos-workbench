// 改进提案不能动权限：模板的模型、写入范围、工具组、MCP，工作流里角色的这些字段和检查命令。
// 这些决定"agent 能做什么、平台替它执行什么"，只能由人在团队约定页手动改（ADR-004）。纯函数。
import { parseTemplate } from '../workflow/agent.ts'
import { parseWorkflow } from '../workflow/parse.ts'
import type { AgentConfig, TemplateLookup, Workflow } from '../workflow/types.ts'
import type { TargetKind } from '../engine/evidence.ts'

/** 权限相关的字段，键是 YAML 里的写法。 */
const permissionFields = (a: AgentConfig): Record<string, string> => ({
  model: a.model, write: a.write, writePaths: JSON.stringify(a.writePaths), tools: JSON.stringify([...a.denyTools].sort()), mcp: JSON.stringify(a.mcp),
})
const permissionOf = (a: AgentConfig) => JSON.stringify(permissionFields(a))

const commandsOf = (w: Workflow): string[] =>
  w.nodes.flatMap(n => n.checks.flatMap(c => (c.kind === 'run' ? [`${n.id}：${JSON.stringify(c.run)}（${c.timeoutSec} 秒）`] : []))).sort()

const UNPARSABLE = '当前版本无法解析，不能自动核对权限；请在团队约定页手动修改'

/** 节点用到的角色：agent 节点的 role，对话节点的评审方（可以没有）。 */
const rolesAt = (w: Workflow): Map<string, string | undefined> => new Map(w.nodes.map(n => [n.id, n.role]))

/**
 * 新内容相对旧内容改了哪些权限相关的东西（中文说明）；没有就是空数组。失败就关：旧内容解析不了时直接拒绝。
 * 工作流：已有角色的权限不变；新角色的权限必须和旧工作流里某个角色完全相同；已有节点用的角色权限不变；
 * 新节点用的角色权限必须是旧工作流里已经有的；检查命令不变。
 */
export const permissionChanges = (kind: TargetKind, before: string, after: string, lookup: TemplateLookup): string[] => {
  if (kind === 'template') {
    const a = parseTemplate(before)
    const b = parseTemplate(after)
    if (!a.ok) return [UNPARSABLE]
    if (!b.ok) return []
    const x = permissionFields(a.template)
    const y = permissionFields(b.template)
    return Object.keys(x).filter(k => x[k] !== y[k]).map(k => `不能改模板的 ${k}`)
  }
  if (kind === 'workflow') {
    const a = parseWorkflow(before, lookup)
    const b = parseWorkflow(after, lookup)
    if (!a.ok) return [UNPARSABLE]
    if (!b.ok) return [] // 新内容另有保存校验
    const out: string[] = []
    const existing = new Set(Object.values(a.workflow.roles).map(permissionOf))
    for (const [id, role] of Object.entries(b.workflow.roles)) {
      const old = a.workflow.roles[id]
      if (old === undefined) {
        if (!existing.has(permissionOf(role))) out.push(`新增的角色「${id}」的模型、写入范围、工具或 MCP 必须和已有的某个角色完全相同`)
      } else if (permissionOf(old) !== permissionOf(role)) out.push(`不能改角色「${id}」的模型、写入范围、工具或 MCP（包括换成别的模板）`)
    }
    const perm = (w: Workflow, role: string | undefined) => (role === undefined ? 'none' : permissionOf(w.roles[role]!))
    const oldAt = rolesAt(a.workflow)
    for (const [node, role] of rolesAt(b.workflow)) {
      if (oldAt.has(node)) {
        if (perm(a.workflow, oldAt.get(node)) !== perm(b.workflow, role)) out.push(`不能让节点「${node}」换成权限不同的角色`)
      } else if (role !== undefined && !existing.has(perm(b.workflow, role))) out.push(`新增的节点「${node}」只能用已有权限的角色`)
    }
    if (JSON.stringify(commandsOf(a.workflow)) !== JSON.stringify(commandsOf(b.workflow))) out.push('不能改检查命令')
    return out
  }
  return []
}
