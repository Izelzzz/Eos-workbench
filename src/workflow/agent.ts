// Agent 配置的解析：模板（YAML）、工作流里直接写的角色、技能（Markdown）。纯函数，错误用中文、带位置。
import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'
import type { AgentConfig, AgentTemplate, McpServer } from './types.ts'
import { TOOL_GROUPS } from './types.ts'

export type FieldError = { path: string; message: string }

export const DEFAULT_MODEL = 'deepseek-flash'
export const ID = /^[a-z][a-z0-9-]{0,31}$/
const MCP_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** 看起来像密钥的环境变量名：模板以明文保存、页面上人人可见，不能放密钥。 */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i

export const text = z.string({ error: '必须是文字' }).trim().min(1, { error: '不能为空' })
export const id = z.string({ error: '必须是文字' }).regex(ID, { error: '只能用小写字母、数字和连字符，以字母开头，最长 32 个字符' })

/** worktree 内的相对路径或 glob：不能是绝对路径，也不能用 .. 跳出去。 */
export const relPath = text.refine(p => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'), {
  error: '必须是 worktree 内的相对路径，用 / 分隔，不能以 / 开头，也不能包含 .. 或反斜杠',
})

const mcpServer = z.object({
  name: z.string({ error: '必须是文字' }).regex(MCP_NAME, { error: '只能用字母、数字、下划线和连字符，最长 32 个字符' }),
  command: text,
  args: z.array(text, { error: '必须是列表' }).default([]),
  env: z.record(z.string(), z.string({ error: '必须是文字' }), { error: '必须是对象' }).default({}),
}, { error: '必须是对象，例如 { name: docs, command: node, args: [server.mjs] }' }).strict()

/** 模板和直接写的角色共用的字段。 */
export const agentFields = {
  model: text.default(DEFAULT_MODEL),
  effort: z.enum(['low', 'high', 'max'], { error: '只能是 low、high 或 max' }).optional(),
  prompt: text,
  write: z.enum(['none', 'worktree'], { error: '只能是 none 或 worktree' }).default('none'),
  writePaths: z.array(relPath, { error: '必须是路径列表，例如 [src/**, tests/**]' }).min(1, { error: '至少要有一个路径' }).optional(),
  tools: z.object({
    deny: z.array(z.enum(TOOL_GROUPS, { error: `只能是 ${TOOL_GROUPS.join('、')} 之一` }), { error: '必须是列表' }).default([]),
  }, { error: '必须是对象，例如 { deny: [web, subagent] }' }).strict().default({ deny: [] }),
  skills: z.array(id, { error: '必须是技能名组成的列表' }).default([]),
  mcp: z.array(mcpServer, { error: '必须是列表' }).default([]),
}

type AgentFieldsOut = z.infer<z.ZodObject<typeof agentFields>>

/** 字段之间的检查：只读角色不能写 writePaths；MCP 服务名不能重复；env 里不能放密钥。path 是这些字段所在的位置前缀。 */
export const agentErrors = (a: AgentFieldsOut, at: (field: string) => string): FieldError[] => {
  const errors: FieldError[] = []
  if (a.write === 'none' && a.writePaths !== undefined) errors.push({ path: at('writePaths'), message: '只读（write: none）的角色不需要 writePaths；要允许写入，把 write 改成 worktree' })
  const seen = new Set<string>()
  a.mcp.forEach((m, i) => {
    if (seen.has(m.name)) errors.push({ path: at(`mcp[${i}].name`), message: `MCP 服务名「${m.name}」重复` })
    seen.add(m.name)
    for (const k of Object.keys(m.env)) {
      if (SECRET_NAME.test(k)) errors.push({ path: at(`mcp[${i}].env.${k}`), message: '模板以明文保存，不能放密钥；需要密钥的 MCP 服务第一版不支持' })
    }
  })
  if (new Set(a.tools.deny).size !== a.tools.deny.length) errors.push({ path: at('tools.deny'), message: '工具组重复' })
  if (new Set(a.skills).size !== a.skills.length) errors.push({ path: at('skills'), message: '技能重复' })
  return errors
}

export const toAgentConfig = (a: AgentFieldsOut): AgentConfig => ({
  model: a.model,
  ...(a.effort === undefined ? {} : { effort: a.effort }),
  prompt: a.prompt,
  write: a.write,
  writePaths: a.write === 'worktree' ? a.writePaths ?? ['**'] : [],
  denyTools: a.tools.deny,
  skills: a.skills,
  mcp: a.mcp.map((m): McpServer => ({ name: m.name, command: m.command, args: m.args, env: m.env })),
})

export const pathOf = (path: readonly PropertyKey[]): string =>
  path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc === '' ? String(p) : `${acc}.${String(p)}`), '') || '(根)'

/** 解析时要带 { reportInput: true }：否则 issue.input 总是空的，类型写错也会被报成"缺少这个字段"。 */
export const zodMessage = (issue: z.core.$ZodIssue): string => {
  if (issue.code === 'unrecognized_keys') return `不认识的字段：${issue.keys.join('、')}`
  if (issue.code === 'invalid_type' && issue.input === undefined) return '缺少这个字段'
  return issue.message
}

export const yamlOf = (source: string): { ok: true; value: unknown } | { ok: false; errors: FieldError[] } => {
  try {
    return { ok: true, value: parseYaml(source) }
  } catch (e) {
    const where = e instanceof YAMLParseError && e.linePos ? `第 ${e.linePos[0].line} 行` : '(根)'
    return { ok: false, errors: [{ path: where, message: `YAML 格式错误：${(e as Error).message.split('\n')[0]}` }] }
  }
}

const templateSchema = z.object({ name: id, description: z.string().optional(), ...agentFields }, { error: '模板必须是对象' }).strict()

export type TemplateResult = { ok: true; template: AgentTemplate } | { ok: false; errors: FieldError[] }

export const parseTemplate = (source: string): TemplateResult => {
  const y = yamlOf(source)
  if (!y.ok) return y
  const parsed = templateSchema.safeParse(y.value, { reportInput: true })
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(i => ({ path: pathOf(i.path), message: zodMessage(i) })) }
  const errors = agentErrors(parsed.data, f => f)
  if (errors.length > 0) return { ok: false, errors }
  const { name, description, ...rest } = parsed.data
  return { ok: true, template: { name, ...(description === undefined ? {} : { description }), ...toAgentConfig(rest) } }
}

export type Skill = { name: string; description: string; body: string }
export type SkillResult = { ok: true; skill: Skill } | { ok: false; errors: FieldError[] }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const skillHead = z.object({ name: id, description: text }, { error: '开头的 --- 之间必须是 name 和 description' }).passthrough()

/** 技能：Markdown，开头是 --- 包住的 name 和 description（dsh 的 SKILL.md 格式），正文是技能内容。 */
export const parseSkill = (source: string): SkillResult => {
  const m = FRONTMATTER.exec(source)
  if (m === null) return { ok: false, errors: [{ path: '(开头)', message: '技能要以 --- 开头，写上 name 和 description，再用 --- 结束，例如：\n---\nname: write-changes\ndescription: 写改动说明时使用\n---' }] }
  const y = yamlOf(m[1]!)
  if (!y.ok) return y
  const head = skillHead.safeParse(y.value, { reportInput: true })
  if (!head.success) return { ok: false, errors: head.error.issues.map(i => ({ path: pathOf(i.path), message: zodMessage(i) })) }
  if (m[2]!.trim() === '') return { ok: false, errors: [{ path: '(正文)', message: '技能正文不能为空' }] }
  return { ok: true, skill: { name: head.data.name, description: head.data.description, body: m[2]! } }
}
