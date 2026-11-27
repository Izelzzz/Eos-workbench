// 改进提案不能动权限：模板的执行器、模型、写入范围、工具组、MCP，工作流里角色的这些字段和检查命令。
// 这些决定"agent 能做什么、平台替它执行什么"，只能由人在团队约定页手动改（ADR-004）。纯函数。
import { parseTemplate } from '../workflow/agent.ts'
import { parseWorkflow } from '../workflow/parse.ts'
import { roleOfNode, type AgentConfig, type TemplateLookup, type Workflow } from '../workflow/types.ts'
import type { TargetKind } from '../engine/evidence.ts'

/** 权限相关的字段，键是 YAML 里的写法。 */
const permissionFields = (a: AgentConfig): Record<string, string> => ({
  executor: a.executor ?? '',
  model: a.model ?? '',
  write: a.write,
  writePaths: JSON.stringify(a.writePaths),
  tools: JSON.stringify([...a.denyTools].sort()),
  mcp: JSON.stringify(a.mcp),
})
const permissionOf = (a: AgentConfig) => JSON.stringify(permissionFields(a))

/**
 * 检查命令和平台动作：都是平台替 agent 执行的，改进提案不能增删改。平台动作连同它前面有哪些评审节点一起比较：
 * 提案不能删掉推送前的评审、也不能把交付节点挪到评审前面。
 */
const commandsOf = (w: Workflow): string[] =>
  w.nodes
    // 卡点的检查是从前面节点的检查算出来的（打回修改后重跑），不另算一份。
    .flatMap((n, i) =>
      (n.kind === 'gate' ? [] : n.checks).flatMap(c => {
        if (c.kind === 'run') return [`${n.id}：${JSON.stringify(c.run)}（${c.timeoutSec} 秒）`]
        if (c.kind !== 'platform') return []
        const reviews = w.nodes
          .slice(0, i)
          .filter(p => p.kind === 'dialog' && p.role !== undefined)
          .map(p => p.id)
          .sort()
        return [`${n.id}：平台动作 ${c.action}（之前的评审：${reviews.join('、')}）`]
      }),
    )
    .sort()

const UNPARSABLE = '当前版本无法解析，不能自动核对权限；请在团队约定页手动修改'

/** 节点用到的角色：agent 节点的 role，对话节点的评审方（可以没有）。 */
const rolesAt = (w: Workflow): Map<string, string | undefined> => new Map(w.nodes.map(n => [n.id, roleOfNode(n)]))

/** 卡点：验收什么、由谁验收。改进提案可以加卡点（加严），不能删掉或改掉已有的（放宽要人批）。 */
const gatesOf = (w: Workflow): Map<string, string> => new Map(w.nodes.flatMap(n => (n.kind === 'gate' ? [[n.id, JSON.stringify({ with: n.with, by: n.by })] as const] : [])))

/**
 * 卡点之后、到它后面最后一个交付节点（平台动作）为止的节点：人验收通过之后，这些节点还能让 agent 改代码，
 * 改动会不经验收就推送出去。按节点的全部字段比较（工作说明和输入除外），人验收的卡点除外（只会让推送前多一道人工验收）。
 * 提案不能往这里加节点、也不能改这里已有节点的做法（例如换 with、换成 agent 验收的卡点）；可以删，也可以加人验收的卡点。
 */
const afterGate = (w: Workflow, gate: string): string[] => {
  const rest = w.nodes.slice(w.nodes.findIndex(n => n.id === gate) + 1)
  const last = rest.findLastIndex(n => n.checks.some(c => c.kind === 'platform'))
  return rest
    .slice(0, last + 1)
    .filter(n => !(n.kind === 'gate' && n.by.kind === 'human'))
    .map(shape)
}

/**
 * 比较用的节点内容：工作说明和输入不算（改它们不改变谁能动代码、推送前经过哪些关）。
 * 卡点的检查是从别的节点算出来的，也不算：那些节点自己的改动另有核对，算进来会把原因记到卡点头上。
 */
const shape = ({ task: _task, inputs: _inputs, ...n }: Workflow['nodes'][number]): string => JSON.stringify(n.kind === 'gate' ? { ...n, checks: undefined } : n)
const idOf = (shaped: string): string => (JSON.parse(shaped) as { id: string }).id

/**
 * 推送前的那一段：从第一个排在交付节点（平台动作）前面的对话节点（评审或测试），到最后一个交付节点为止，按顺序。
 * 这一段决定改动推送之前经过哪些评审和检查：提案在这里加、挪、删节点，或者改节点的做法（例如换评审的 with），
 * 都可能让改动不经评审就推送出去，所以按顺序整段比较。人验收的卡点除外：加一个只会让推送前多一道人工验收。
 * 没有交付节点时没有这一段（不推送）。
 */
const beforeDelivery = (w: Workflow): string[] => {
  const last = w.nodes.findLastIndex(n => n.checks.some(c => c.kind === 'platform'))
  if (last < 0) return []
  const first = w.nodes.findIndex((n, i) => i < last && n.kind === 'dialog' && !n.checks.some(c => c.kind === 'platform'))
  return w.nodes
    .slice(first < 0 ? last : first, last + 1)
    .filter(n => !(n.kind === 'gate' && n.by.kind === 'human'))
    .map(shape)
}

/**
 * 新内容相对旧内容改了哪些权限相关的东西（中文说明）；没有就是空数组。失败就关：旧内容解析不了时直接拒绝。
 * 工作流：已有角色的权限不变；新角色的权限必须和旧工作流里某个角色完全相同；已有节点用的角色权限不变；
 * 新节点用的角色权限必须是旧工作流里已经有的；检查命令不变；推送前的那一段（评审到交付）不变；卡点不删不改。
 */
export const permissionChanges = (kind: TargetKind, before: string, after: string, lookup: TemplateLookup): string[] => {
  if (kind === 'template') {
    const a = parseTemplate(before)
    const b = parseTemplate(after)
    if (!a.ok) return [UNPARSABLE]
    if (!b.ok) return []
    const x = permissionFields(a.template)
    const y = permissionFields(b.template)
    // 模型写明前后的值：不写时用执行器的默认模型，从「写了」到「不写」也是改动，要让人看到最后用的是什么
    const model = (v: string | undefined) => (v === undefined || v === '' ? '执行器默认' : v)
    return Object.keys(x)
      .filter(k => x[k] !== y[k])
      .map(k => (k === 'model' ? `不能改模板的 model（${model(a.template.model)} → ${model(b.template.model)}）` : `不能改模板的 ${k}`))
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
        if (!existing.has(permissionOf(role))) out.push(`新增的角色「${id}」的执行器、模型、写入范围、工具或 MCP 必须和已有的某个角色完全相同`)
      } else if (permissionOf(old) !== permissionOf(role)) out.push(`不能改角色「${id}」的执行器、模型、写入范围、工具或 MCP（包括换成别的模板）`)
    }
    const perm = (w: Workflow, role: string | undefined) => (role === undefined ? 'none' : permissionOf(w.roles[role]!))
    const oldAt = rolesAt(a.workflow)
    for (const [node, role] of rolesAt(b.workflow)) {
      if (oldAt.has(node)) {
        if (perm(a.workflow, oldAt.get(node)) !== perm(b.workflow, role)) out.push(`不能让节点「${node}」换成权限不同的角色`)
      } else if (role !== undefined && !existing.has(perm(b.workflow, role))) out.push(`新增的节点「${node}」只能用已有权限的角色`)
    }
    if (JSON.stringify(commandsOf(a.workflow)) !== JSON.stringify(commandsOf(b.workflow))) out.push('不能改检查命令和平台动作')
    const [x, y] = [beforeDelivery(a.workflow), beforeDelivery(b.workflow)]
    if (x.length > 0 && JSON.stringify(x) !== JSON.stringify(y)) {
      const changed = [...new Set([...x.filter(n => !y.includes(n)), ...y.filter(n => !x.includes(n))].map(idOf))]
      out.push(`不能改评审到交付之间的节点（${changed.length > 0 ? changed.join('、') : '顺序'}）：加、挪、删节点或改它们的做法，都可能让改动不经评审就推送；只能加人验收的卡点`)
    }
    const newGates = gatesOf(b.workflow)
    for (const [id, g] of gatesOf(a.workflow)) {
      if (newGates.get(id) !== g) {
        out.push(`不能删掉卡点「${id}」，也不能改它验收的节点和验收人`)
        continue
      }
      const before = new Set(afterGate(a.workflow, id))
      const added = afterGate(b.workflow, id)
        .filter(n => !before.has(n))
        .map(idOf)
      if (added.length > 0) out.push(`不能在卡点「${id}」和交付之间加节点或改节点（${added.join('、')}）：验收通过之后的改动会不经验收就推送`)
    }
    return out
  }
  return []
}
