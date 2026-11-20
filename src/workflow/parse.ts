// 把 YAML 文本解析成 Workflow，并做语义校验。错误用中文，带出错位置（例如 nodes[2].with）。
import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'
import type { NodeId, RoleId, Workflow, WorkflowNode } from './types.ts'

export type WorkflowError = { path: string; message: string }
export type ParseResult = { ok: true; workflow: Workflow } | { ok: false; errors: WorkflowError[] }

export const DEFAULT_MODEL = 'deepseek-flash'
export const DEFAULT_MAX_ROUNDS = 5
const ID = /^[a-z][a-z0-9-]{0,31}$/

const text = z.string({ error: '必须是文字' }).trim().min(1, { error: '不能为空' })
const id = z.string({ error: '必须是文字' }).regex(ID, { error: '只能用小写字母、数字和连字符，以字母开头，最长 32 个字符' })
const names = z.array(text, { error: '必须是列表' })

const roleSchema = z.object({
  model: text.default(DEFAULT_MODEL),
  effort: z.enum(['low', 'high', 'max'], { error: '只能是 low、high 或 max' }).optional(),
  prompt: text,
  write: z.enum(['none', 'worktree'], { error: '只能是 none 或 worktree' }).default('none'),
  tools: names.optional(),
  skills: names.optional(),
}, { error: '必须是对象' }).strict()

const common = { id, role: id, task: text, inputs: z.array(id, { error: '必须是列表' }).default([]) }

const nodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), ...common }).strict(),
  z.object({
    kind: z.literal('dialog'),
    ...common,
    with: id,
    escalate: id.optional(),
    maxRounds: z.number({ error: '必须是数字' }).int({ error: '必须是整数' }).min(1, { error: '至少 1 轮' }).max(20, { error: '最多 20 轮' }).default(DEFAULT_MAX_ROUNDS),
  }).strict(),
], { error: 'kind 只能是 agent 或 dialog' })

const workflowSchema = z.object({
  name: id,
  description: z.string().optional(),
  roles: z.record(id, roleSchema, { error: '必须是对象' }),
  nodes: z.array(nodeSchema, { error: '必须是列表' }).min(1, { error: '至少要有一个节点' }),
}, { error: '工作流必须是对象' }).strict()

const pathOf = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc === '' ? String(p) : `${acc}.${String(p)}`), '') || '(根)'

const zodMessage = (issue: z.core.$ZodIssue): string => {
  if (issue.code === 'unrecognized_keys') return `不认识的字段：${issue.keys.join('、')}`
  if (issue.code === 'invalid_type' && issue.input === undefined) return '缺少这个字段'
  return issue.message
}

/** 结构正确之后的引用检查：角色存在、只引用前面的节点、对话和重新确认的对象是 agent 节点。 */
const semantic = (wf: Workflow): WorkflowError[] => {
  const errors: WorkflowError[] = []
  const seen = new Map<string, WorkflowNode>()
  wf.nodes.forEach((n, i) => {
    const at = (field: string) => `nodes[${i}].${field}`
    if (seen.has(n.id)) errors.push({ path: at('id'), message: `节点 id「${n.id}」重复` })
    if (wf.roles[n.role] === undefined) errors.push({ path: at('role'), message: `没有名为「${n.role}」的角色` })
    n.inputs.forEach((input, j) => {
      if (!seen.has(input)) errors.push({ path: `${at('inputs')}[${j}]`, message: `「${input}」必须是排在前面的节点` })
    })
    if (n.kind === 'dialog') {
      const target = seen.get(n.with)
      if (target === undefined) errors.push({ path: at('with'), message: `「${n.with}」必须是排在前面的节点` })
      else if (target.kind !== 'agent') errors.push({ path: at('with'), message: `「${n.with}」必须是 agent 节点` })
      if (n.escalate !== undefined) {
        const up = seen.get(n.escalate)
        if (up === undefined) errors.push({ path: at('escalate'), message: `「${n.escalate}」必须是排在前面的节点` })
        else if (up.kind !== 'agent') errors.push({ path: at('escalate'), message: `「${n.escalate}」必须是 agent 节点` })
        else if (n.escalate === n.with) errors.push({ path: at('escalate'), message: '重新确认的对象不能是被评审的节点本身' })
      }
    }
    seen.set(n.id, n)
  })
  return errors
}

export const parseWorkflow = (source: string): ParseResult => {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (e) {
    const where = e instanceof YAMLParseError && e.linePos ? `第 ${e.linePos[0].line} 行` : '(根)'
    return { ok: false, errors: [{ path: where, message: `YAML 格式错误：${(e as Error).message.split('\n')[0]}` }] }
  }
  const parsed = workflowSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(i => ({ path: pathOf(i.path), message: zodMessage(i) })) }
  }
  const p = parsed.data
  const workflow: Workflow = {
    name: p.name,
    ...(p.description === undefined ? {} : { description: p.description }),
    roles: Object.fromEntries(Object.entries(p.roles).map(([k, r]) => [k, { id: k as RoleId, ...r }])),
    nodes: p.nodes.map(n => ({ ...n, id: n.id as NodeId, role: n.role as RoleId, inputs: n.inputs as NodeId[],
      ...(n.kind === 'dialog' ? { with: n.with as NodeId, ...(n.escalate === undefined ? {} : { escalate: n.escalate as NodeId }) } : {}) })) as WorkflowNode[],
  }
  const errors = semantic(workflow)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, workflow }
}

export const formatErrors = (errors: WorkflowError[]): string => errors.map(e => `- ${e.path}：${e.message}`).join('\n')
