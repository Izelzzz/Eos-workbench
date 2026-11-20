// 团队约定：平台上维护的工作流（YAML）、约定文档（Markdown）、Agent 模板（YAML）和技能（Markdown），带版本。
// 保存时校验（错误用中文、带位置），任务创建时解析出要用的版本并快照下来。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ConventionDoc } from '../engine/types.ts'
import type { Store } from '../store/store.ts'
import type { ConventionKind, ConventionRow, ConventionsUsed, ConventionSummary, SkillSnapshot } from '../store/types.ts'
import { parseSkill, parseTemplate } from '../workflow/agent.ts'
import type { WorkflowError } from '../workflow/parse.ts'
import { parseWorkflow } from '../workflow/parse.ts'
import { builtinAgentSource, builtinAgentTemplates, builtinSkillSource, builtinSkills, builtinTemplates, loadWorkflow } from '../workflow/templates.ts'
import type { TemplateLookup, Workflow } from '../workflow/types.ts'

const DOCS_DIR = join(import.meta.dirname, '..', 'workflow', 'docs')
const DOC_NAME = /^[^/\\\n]{1,64}$/

export type SaveResult = { ok: true; row: ConventionRow } | { ok: false; errors: WorkflowError[] }
export type Resolved =
  | { ok: true; workflow: Workflow; source: string; docs: ConventionDoc[]; skills: SkillSnapshot[]; used: ConventionsUsed }
  | { ok: false; error: string }

export type WorkflowSummary = ConventionSummary & { description?: string; nodes: string[] }
export type TemplateSummary = ConventionSummary & { description?: string; write?: 'none' | 'worktree' }
export type SkillSummary = ConventionSummary & { description?: string }

export const builtinDocs = (): string[] => readdirSync(DOCS_DIR).filter(f => extname(f) === '.md').map(f => basename(f, '.md')).sort()

export class Conventions {
  constructor(private readonly store: Store) {}

  /** 平台上还没有的内置模板和文档写成第 1 版；已有的（包括用户改过的）不动。返回新写入的名字。 */
  seed(at: number): string[] {
    const added: string[] = []
    const put = (kind: ConventionKind, name: string, content: string) => {
      if (this.store.seedConvention({ kind, name, content, note: '内置模板', actor: 'platform' }, at)) added.push(name)
    }
    // 顺序：被引用的先写（工作流引用模板和文档，模板引用技能）。
    for (const name of builtinDocs()) put('doc', name, readFileSync(join(DOCS_DIR, `${name}.md`), 'utf8'))
    for (const name of builtinSkills()) put('skill', name, builtinSkillSource(name))
    for (const name of builtinAgentTemplates()) put('template', name, builtinAgentSource(name))
    for (const name of builtinTemplates()) put('workflow', name, loadWorkflow(name, this.lookup()).source)
    return added
  }

  list(kind: 'doc'): ConventionSummary[]
  list(kind: 'workflow'): WorkflowSummary[]
  list(kind: 'template'): TemplateSummary[]
  list(kind: 'skill'): SkillSummary[]
  list(kind: ConventionKind): ConventionSummary[] | WorkflowSummary[] | TemplateSummary[] | SkillSummary[] {
    const rows = this.store.conventions(kind)
    // 保存时已经校验过；解析器升级后旧版本可能不再合法，这里不让列表因此出错，只是少了说明。
    const latest = (name: string) => this.store.convention(kind, name)!.content
    if (kind === 'doc') return rows
    if (kind === 'template') {
      return rows.map(r => {
        const t = parseTemplate(latest(r.name))
        return t.ok ? { ...r, ...(t.template.description === undefined ? {} : { description: t.template.description }), write: t.template.write } : r
      })
    }
    if (kind === 'skill') {
      return rows.map(r => {
        const k = parseSkill(latest(r.name))
        return k.ok ? { ...r, description: k.skill.description } : r
      })
    }
    const lookup = this.lookup()
    return rows.map(r => {
      const parsed = parseWorkflow(latest(r.name), lookup)
      if (!parsed.ok) return { ...r, nodes: [] }
      const { description, nodes } = parsed.workflow
      return { ...r, ...(description === undefined ? {} : { description }), nodes: nodes.map(n => n.id) }
    })
  }

  /** 平台上每个 Agent 模板的最新版本。版本无法解析的模板当作不存在（引用它的工作流会报错）。 */
  lookup(): TemplateLookup {
    return name => {
      const row = this.store.convention('template', name)
      if (row === undefined) return undefined
      const t = parseTemplate(row.content)
      return t.ok ? { template: t.template, version: row.version } : undefined
    }
  }

  /** 校验并保存为新版本。name 是要保存到的约定名；工作流的名字必须和 YAML 里的 name 一致。 */
  save(p: { kind: ConventionKind; name: string; content: string; note?: string; actor: string }, at: number): SaveResult {
    const errors = this.validate(p.kind, p.name, p.content)
    if (errors.length > 0) return { ok: false, errors }
    if (this.store.convention(p.kind, p.name)?.content === p.content) return { ok: false, errors: [{ path: '(内容)', message: '内容和当前版本完全一样，没有保存新版本' }] }
    return { ok: true, row: this.store.saveConvention({ kind: p.kind, name: p.name, content: p.content, note: p.note?.trim() ?? '', actor: p.actor }, at) }
  }

  /** 只校验不保存：页面上边写边检查用。 */
  validate(kind: ConventionKind, name: string, content: string): WorkflowError[] {
    switch (kind) {
      case 'workflow': return this.validateWorkflow(name, content)
      case 'doc': return this.validateDoc(name, content)
      case 'template': return this.validateTemplate(name, content)
      case 'skill': return this.validateSkill(name, content)
    }
  }

  private validateTemplate(name: string, content: string): WorkflowError[] {
    const r = parseTemplate(content)
    if (!r.ok) return r.errors
    const errors: WorkflowError[] = []
    if (r.template.name !== name) errors.push({ path: 'name', message: `模板名「${r.template.name}」和要保存的「${name}」不一致；要改名请新建一个模板` })
    r.template.skills.forEach((k, i) => {
      if (this.store.convention('skill', k) === undefined) errors.push({ path: `skills[${i}]`, message: `平台上没有名为「${k}」的技能` })
    })
    return errors
  }

  private validateSkill(name: string, content: string): WorkflowError[] {
    const r = parseSkill(content)
    if (!r.ok) return r.errors
    return r.skill.name === name ? [] : [{ path: 'name', message: `技能名「${r.skill.name}」和要保存的「${name}」不一致；要改名请新建一个技能` }]
  }

  private validateWorkflow(name: string, content: string): WorkflowError[] {
    const r = parseWorkflow(content, this.lookup())
    if (!r.ok) return r.errors
    const errors: WorkflowError[] = []
    if (r.workflow.name !== name) errors.push({ path: 'name', message: `工作流名「${r.workflow.name}」和要保存的「${name}」不一致；要改名请新建一个工作流` })
    r.workflow.docs.forEach((d, i) => {
      if (this.store.convention('doc', d) === undefined) errors.push({ path: `docs[${i}]`, message: `平台上没有名为「${d}」的约定文档` })
    })
    return errors
  }

  private validateDoc(name: string, content: string): WorkflowError[] {
    const errors: WorkflowError[] = []
    if (!DOC_NAME.test(name.trim()) || name !== name.trim()) errors.push({ path: 'name', message: '文档名 1 到 64 个字符，不能包含 / 或 \\，首尾不能有空格' })
    if (content.trim() === '') errors.push({ path: '(内容)', message: '文档内容不能为空' })
    return errors
  }

  /**
   * 任务要用的工作流和约定文档（各自的最新版本）。平台上没有这个名字时，按 YAML 文件路径加载（命令行用），
   * 文档仍然从平台取。
   */
  resolve(nameOrPath: string): Resolved {
    const row = this.store.convention('workflow', nameOrPath)
    let workflow: Workflow
    let source: string
    if (row !== undefined) {
      const parsed = parseWorkflow(row.content, this.lookup())
      if (!parsed.ok) return { ok: false, error: `工作流「${row.name}」第 ${row.version} 版无法使用：${parsed.errors.map(e => `${e.path}：${e.message}`).join('；')}。请在团队约定页修正后再试` }
      ;({ workflow, source } = { workflow: parsed.workflow, source: row.content })
    } else if (existsSync(nameOrPath)) {
      try {
        ;({ workflow, source } = loadWorkflow(nameOrPath, this.lookup()))
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    } else {
      const names = this.store.conventions('workflow').map(w => w.name)
      return { ok: false, error: `平台上没有工作流「${nameOrPath}」。现有：${names.join('、') || '（无）'}` }
    }
    const docs: ConventionDoc[] = []
    for (const name of workflow.docs) {
      const d = this.store.convention('doc', name)
      if (d === undefined) return { ok: false, error: `工作流「${workflow.name}」要用的约定文档「${name}」在平台上不存在` }
      docs.push({ name, version: d.version, content: d.content })
    }
    // 角色用到的技能：快照内容，执行时写成这个角色的技能目录。
    const skills: SkillSnapshot[] = []
    for (const name of [...new Set(Object.values(workflow.roles).flatMap(r => r.skills))].sort()) {
      const k = this.store.convention('skill', name)
      if (k === undefined) return { ok: false, error: `工作流「${workflow.name}」的角色要用的技能「${name}」在平台上不存在` }
      skills.push({ name, version: k.version, content: k.content })
    }
    const templates = [...new Map(Object.values(workflow.roles).flatMap(r => (r.template === undefined ? [] : [[r.template.name, r.template] as const]))).values()]
    return {
      ok: true, workflow, source, docs, skills,
      used: {
        workflow: { name: workflow.name, ...(row === undefined ? {} : { version: row.version }) }, docs: docs.map(d => ({ name: d.name, version: d.version })),
        templates, skills: skills.map(k => ({ name: k.name, version: k.version })),
      },
    }
  }
}
