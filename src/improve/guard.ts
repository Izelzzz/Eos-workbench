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

/** 新内容相对旧内容改了哪些权限相关的东西（中文说明）；没有就是空数组。旧内容解析不了时不比较（新内容另有保存校验）。 */
export const permissionChanges = (kind: TargetKind, before: string, after: string, lookup: TemplateLookup): string[] => {
  if (kind === 'template') {
    const a = parseTemplate(before)
    const b = parseTemplate(after)
    if (!a.ok || !b.ok) return []
    const x = permissionFields(a.template)
    const y = permissionFields(b.template)
    return Object.keys(x).filter(k => x[k] !== y[k]).map(k => `不能改模板的 ${k}`)
  }
  if (kind === 'workflow') {
    const a = parseWorkflow(before, lookup)
    const b = parseWorkflow(after, lookup)
    if (!a.ok || !b.ok) return []
    const out: string[] = []
    for (const [id, role] of Object.entries(b.workflow.roles)) {
      const old = a.workflow.roles[id]
      if (old === undefined) {
        if (role.write !== 'none' || role.mcp.length > 0) out.push(`新增的角色「${id}」不能可写或挂 MCP 服务`)
      } else if (permissionOf(old) !== permissionOf(role)) out.push(`不能改角色「${id}」的模型、写入范围、工具或 MCP（包括换成别的模板）`)
    }
    if (JSON.stringify(commandsOf(a.workflow)) !== JSON.stringify(commandsOf(b.workflow))) out.push('不能改检查命令')
    return out
  }
  return []
}
