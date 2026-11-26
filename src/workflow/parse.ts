// 把 YAML 文本解析成 Workflow，并做语义校验。错误用中文，带出错位置（例如 nodes[2].with）。
// 角色可以直接写配置，也可以引用平台上的 Agent 模板（{ template: developer }）；模板由调用方注入的 lookup 查找，解析保持纯函数。
import { matchesAny } from './glob.ts'
import { z } from 'zod'
import type { FieldError } from './agent.ts'
import { agentErrors, agentFields, DEFAULT_MODEL, id, pathOf, relPath, text, toAgentConfig, yamlOf, zodMessage } from './agent.ts'
import { PLATFORM_ACTIONS, roleOfNode, type Check, type GateNode, type NodeId, type Role, type RoleId, type TemplateLookup, type Workflow, type WorkflowNode } from './types.ts'

export type WorkflowError = FieldError
export type ParseResult = { ok: true; workflow: Workflow } | { ok: false; errors: WorkflowError[] }

export { DEFAULT_MODEL }
export const DEFAULT_MAX_ROUNDS = 5
export const DEFAULT_MAX_FIXES = 2
export const DEFAULT_CHECK_TIMEOUT_SEC = 600

const names = z.array(text, { error: '必须是列表' })

const inlineRole = z.object(agentFields, { error: '必须是对象' }).strict()
const templateRef = z.object({ template: id }, { error: '必须是对象' }).strict()

/**
 * 角色：有 template 字段就是引用模板（只能有这一个字段），否则是直接写的配置。
 * 分开解析而不是用 union，这样错误能精确到字段（union 只会报"不匹配任何一种"）。
 */
const parseRole = (key: string, raw: unknown, lookup: TemplateLookup): { role?: Role; errors: WorkflowError[] } => {
  const at = (field: string) => `roles.${key}${field === '' ? '' : `.${field}`}`
  const isRef = typeof raw === 'object' && raw !== null && 'template' in raw
  if (isRef) {
    const r = templateRef.safeParse(raw, { reportInput: true })
    if (!r.success) return { errors: r.error.issues.map(i => ({ path: at(pathOf(i.path).replace('(根)', '')), message: zodMessage(i) })) }
    const found = lookup(r.data.template)
    if (found === undefined) return { errors: [{ path: at('template'), message: `平台上没有名为「${r.data.template}」的 Agent 模板` }] }
    const { name, description: _description, ...config } = found.template
    return { role: { id: key as RoleId, ...config, template: { name, version: found.version } }, errors: [] }
  }
  const r = inlineRole.safeParse(raw, { reportInput: true })
  if (!r.success) return { errors: r.error.issues.map(i => ({ path: at(pathOf(i.path).replace('(根)', '')), message: zodMessage(i) })) }
  const errors = agentErrors(r.data, at)
  return errors.length > 0 ? { errors } : { role: { id: key as RoleId, ...toAgentConfig(r.data) }, errors: [] }
}

const deliverable = z
  .object(
    {
      path: relPath,
      sections: names.default([]),
    },
    { error: '必须是对象，例如 { path: docs/spec.md, sections: [背景, 验收标准] }' },
  )
  .strict()

const runCheck = z
  .object(
    {
      run: z.array(text, { error: '必须是命令和参数组成的列表，例如 [npm, test]' }).min(1, { error: '命令不能为空' }),
      timeoutSec: z.number({ error: '必须是数字' }).int({ error: '必须是整数' }).min(1, { error: '至少 1 秒' }).max(3600, { error: '最多 3600 秒' }).default(DEFAULT_CHECK_TIMEOUT_SEC),
    },
    { error: '必须是对象，例如 { run: [npm, test] }' },
  )
  .strict()

const platformCheck = z
  .object(
    {
      platform: z.enum(PLATFORM_ACTIONS, { error: `只能是 ${PLATFORM_ACTIONS.join('、')}` }),
    },
    { error: '必须是对象，例如 { platform: push }' },
  )
  .strict()

const checkFields = {
  deliverables: z.array(deliverable, { error: '必须是列表' }).default([]),
  checks: z.array(z.union([runCheck, platformCheck], { error: '必须是命令检查 { run: [npm, test] } 或平台动作 { platform: push }' }), { error: '必须是列表' }).default([]),
}

const common = { id, task: text, inputs: z.array(id, { error: '必须是列表' }).default([]) }

const maxFixes = z.number({ error: '必须是数字' }).int({ error: '必须是整数' }).min(0, { error: '不能小于 0' }).max(10, { error: '最多 10 次' }).default(DEFAULT_MAX_FIXES)
const maxRounds = z.number({ error: '必须是数字' }).int({ error: '必须是整数' }).min(1, { error: '至少 1 轮' }).max(20, { error: '最多 20 轮' })

const nodeSchema = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('agent'),
        ...common,
        role: id,
        ...checkFields,
        maxFixes,
      })
      .strict(),
    z
      .object({
        kind: z.literal('dialog'),
        ...common,
        role: id.optional(),
        ...checkFields,
        with: id,
        escalate: id.optional(),
        maxRounds: maxRounds.default(DEFAULT_MAX_ROUNDS),
      })
      .strict(),
    // 卡点：by 是 human（能访问平台的任何人）或 agent（role 角色的 agent，最多打回 maxRounds 次）。
    z
      .object({
        kind: z.literal('gate'),
        ...common,
        with: id,
        by: z.enum(['human', 'agent'], { error: '只能是 human（人）或 agent（某个角色的 agent，用 role 指定）' }),
        role: id.optional(),
        maxRounds: maxRounds.optional(),
        maxFixes,
      })
      .strict(),
  ],
  { error: 'kind 只能是 agent、dialog 或 gate' },
)

const workflowSchema = z
  .object(
    {
      name: id,
      description: z.string().optional(),
      docs: z.array(text, { error: '必须是约定文档名组成的列表' }).default([]),
      roles: z.record(id, z.unknown(), { error: '必须是对象' }),
      nodes: z.array(nodeSchema, { error: '必须是列表' }).min(1, { error: '至少要有一个节点' }),
    },
    { error: '工作流必须是对象' },
  )
  .strict()

type ParsedNode = z.infer<typeof nodeSchema>

const checksOf = (n: Exclude<ParsedNode, { kind: 'gate' }>): Check[] => [
  ...n.deliverables.map(d => ({ kind: 'file' as const, path: d.path, sections: d.sections })),
  ...n.checks.map(r => ('platform' in r ? { kind: 'platform' as const, action: r.platform } : { kind: 'run' as const, run: r.run, timeoutSec: r.timeoutSec })),
]

/** 卡点的 by 和 role、maxRounds 要对得上：这几个字段组合不对时在这里报，类型里只留合法的组合。 */
const gateErrors = (nodes: ParsedNode[]): WorkflowError[] =>
  nodes.flatMap((n, i) => {
    if (n.kind !== 'gate') return []
    const at = (field: string) => `nodes[${i}].${field}`
    if (n.by === 'agent') return n.role === undefined ? [{ path: at('role'), message: 'by: agent 时要用 role 指定由哪个角色的 agent 验收' }] : []
    return [
      ...(n.role === undefined ? [] : [{ path: at('role'), message: 'by: human 时不写 role；要由 agent 验收，把 by 改成 agent' }]),
      ...(n.maxRounds === undefined ? [] : [{ path: at('maxRounds'), message: '人验收不限打回次数，maxRounds 只用于 by: agent' }]),
    ]
  })

/**
 * 卡点打回、修改之后重跑的检查：被验收节点自己的，和卡点之前评审或测试它（with 是它）的对话节点的交付物和命令检查。
 * 只有这些是被验收方改得了的（别的节点的交付物由别的角色写）。平台动作不重跑（它们会改到远程）；
 * 同样的检查只跑一次（例如测试和评审两个节点都跑 npm test）。
 */
const gateNode = (n: Extract<ParsedNode, { kind: 'gate' }>, before: ParsedNode[]): GateNode => {
  const seen = new Set<string>()
  const checks = before
    .flatMap(x => (x.kind !== 'gate' && (x.id === n.with || (x.kind === 'dialog' && x.with === n.with)) ? checksOf(x) : []))
    .filter(c => {
      if (c.kind === 'platform') return false
      const k = JSON.stringify(c)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  return {
    kind: 'gate',
    id: n.id as NodeId,
    with: n.with as NodeId,
    by: n.by === 'agent' ? { kind: 'agent', role: n.role! as RoleId, maxRounds: n.maxRounds ?? DEFAULT_MAX_ROUNDS } : { kind: 'human' },
    task: n.task,
    inputs: n.inputs as NodeId[],
    checks,
    maxFixes: n.maxFixes,
  }
}

/** 结构正确之后的引用检查：角色存在、只引用前面的节点、对话和重新确认的对象是 agent 节点。 */
const semantic = (wf: Workflow): WorkflowError[] => {
  const errors: WorkflowError[] = []
  const seen = new Map<string, WorkflowNode>()
  wf.nodes.forEach((n, i) => {
    const at = (field: string) => `nodes[${i}].${field}`
    if (seen.has(n.id)) errors.push({ path: at('id'), message: `节点 id「${n.id}」重复` })
    const r = roleOfNode(n)
    if (r !== undefined && wf.roles[r] === undefined) errors.push({ path: at('role'), message: `没有名为「${r}」的角色` })
    if (n.kind === 'gate') {
      const target = seen.get(n.with)
      if (target === undefined) errors.push({ path: at('with'), message: `「${n.with}」必须是排在前面的节点` })
      else if (target.kind !== 'agent') errors.push({ path: at('with'), message: `「${n.with}」必须是 agent 节点：打回时交回它原来的会话修改` })
      // 打回修改的提交只有在卡点之后的交付里才会推送：放在交付后面，通过的改动推不到远程。
      if ([...seen.values()].some(p => p.checks.some(c => c.kind === 'platform'))) {
        errors.push({ path: at('kind'), message: '卡点要放在交付节点（平台动作）前面：放在后面时，打回修改的提交不会再推送' })
      }
      n.inputs.forEach((input, j) => {
        if (!seen.has(input)) errors.push({ path: `${at('inputs')}[${j}]`, message: `「${input}」必须是排在前面的节点` })
        else if (seen.get(input)!.kind === 'gate') errors.push({ path: `${at('inputs')}[${j}]`, message: `「${input}」是卡点，没有产出` })
      })
      seen.set(n.id, n)
      return
    }
    // 交付物由写文件的那个角色产出：agent 节点是它自己，对话节点是被评审的节点。交付物在它的可写范围外时，
    // 写了会被撤销、检查永远过不了，所以在这里就报错，不留到任务里卡住。
    const writer =
      n.kind === 'agent'
        ? n.role
        : (() => {
            const t = seen.get(n.with)
            return t?.kind === 'agent' ? t.role : undefined
          })()
    const writerRole = writer === undefined ? undefined : wf.roles[writer]
    if (writerRole?.write === 'none' && n.checks.some(c => c.kind === 'file')) {
      errors.push({ path: at('deliverables'), message: `角色「${writer}」只读（write: none），写不出交付物文件；把它的 write 改成 worktree` })
    }
    if (writerRole?.write === 'worktree') {
      n.checks.forEach(c => {
        if (c.kind === 'file' && !matchesAny(writerRole.writePaths, c.path)) {
          errors.push({
            path: at('deliverables'),
            message: `交付物「${c.path}」不在角色「${writer}」的可写范围（${writerRole.writePaths.join('、')}）内，写了会被撤销；把它加进 writePaths，或换一个范围内的路径`,
          })
        }
      })
    }
    // 平台动作（推送等）会改到远程：只放在评审之后单独的交付节点里（没有评审角色的对话节点，前面有带评审角色的对话节点），
    // 而且排在命令检查后面：评审通过、测试等检查也都通过了才做。交付节点的检查没过、交回开发改过之后不会再评审，
    // 所以交付节点的 maxRounds 越小，推出去的未评审改动越少。
    if (n.checks.some(c => c.kind === 'platform')) {
      if (n.kind !== 'dialog' || n.role !== undefined) {
        errors.push({
          path: at('checks'),
          message: '平台动作（platform）只能放在没有评审角色的对话节点里：评审通过之后单独加一个交付节点，例如 { id: deliver, kind: dialog, with: build, checks: [{ platform: push }] }',
        })
      } else if (![...seen.values()].some(p => p.kind === 'dialog' && p.role !== undefined)) {
        errors.push({ path: at('checks'), message: '平台动作（platform）所在的交付节点前面要有带评审角色的对话节点：先评审，通过了再推送' })
      }
      const firstPlatform = n.checks.findIndex(c => c.kind === 'platform')
      if (n.checks.slice(firstPlatform).some(c => c.kind !== 'platform')) {
        errors.push({ path: at('checks'), message: '平台动作（platform）要排在命令检查后面：先跑测试，通过了再推送' })
      }
    }
    if (n.kind === 'dialog' && n.role === undefined && n.checks.length === 0) {
      errors.push({ path: at('role'), message: '对话节点至少要有评审角色（role）或检查（checks、deliverables）其中之一' })
    }
    n.inputs.forEach((input, j) => {
      if (!seen.has(input)) errors.push({ path: `${at('inputs')}[${j}]`, message: `「${input}」必须是排在前面的节点` })
      else if (seen.get(input)!.kind === 'gate') errors.push({ path: `${at('inputs')}[${j}]`, message: `「${input}」是卡点，没有产出` })
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

/** lookup：按名字找 Agent 模板；不给就是没有模板可用（引用模板的角色会报错）。 */
export const parseWorkflow = (source: string, lookup: TemplateLookup = () => undefined): ParseResult => {
  const y = yamlOf(source)
  if (!y.ok) return y
  const parsed = workflowSchema.safeParse(y.value, { reportInput: true })
  // 角色单独解析，和工作流其余部分的错误一起报出来（不因为别处有错就漏报角色的错）。
  const rawRoles = (y.value as { roles?: unknown } | null)?.roles
  const roleEntries = typeof rawRoles === 'object' && rawRoles !== null && !Array.isArray(rawRoles) ? Object.entries(rawRoles) : []
  const roleResults = roleEntries.map(([k, r]) => [k, parseRole(k, r, lookup)] as const)
  const structural = [...(parsed.success ? [] : parsed.error.issues.map(i => ({ path: pathOf(i.path), message: zodMessage(i) }))), ...roleResults.flatMap(([, r]) => r.errors)]
  if (!parsed.success || structural.length > 0) return { ok: false, errors: structural }
  const p = parsed.data
  // by 和 role、maxRounds 的组合不对时先报：组合不对就没有合法的卡点可以往下校验。
  const combos = gateErrors(p.nodes)
  if (combos.length > 0) return { ok: false, errors: combos }
  const workflow: Workflow = {
    name: p.name,
    ...(p.description === undefined ? {} : { description: p.description }),
    roles: Object.fromEntries(roleResults.map(([k, r]) => [k, r.role!])),
    docs: p.docs,
    nodes: p.nodes.map((n, i) => {
      if (n.kind === 'gate') return gateNode(n, p.nodes.slice(0, i))
      const { deliverables: _deliverables, checks: _checks, ...rest } = n
      const checks = checksOf(n)
      return {
        ...rest,
        checks,
        id: n.id as NodeId,
        inputs: n.inputs as NodeId[],
        ...(n.role === undefined ? {} : { role: n.role as RoleId }),
        ...(n.kind === 'dialog' ? { with: n.with as NodeId, ...(n.escalate === undefined ? {} : { escalate: n.escalate as NodeId }) } : {}),
      }
    }) as WorkflowNode[],
  }
  const errors = semantic(workflow)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, workflow }
}

export const formatErrors = (errors: WorkflowError[]): string => errors.map(e => `- ${e.path}：${e.message}`).join('\n')
