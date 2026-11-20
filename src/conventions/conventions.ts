// 团队约定：平台上维护的工作流（YAML）和约定文档（Markdown），带版本。
// 保存时校验（错误用中文、带位置），任务创建时解析出要用的版本并快照下来。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ConventionDoc } from '../engine/types.ts'
import type { Store } from '../store/store.ts'
import type { ConventionKind, ConventionRow, ConventionsUsed, ConventionSummary } from '../store/types.ts'
import type { WorkflowError } from '../workflow/parse.ts'
import { parseWorkflow } from '../workflow/parse.ts'
import { builtinTemplates, loadWorkflow } from '../workflow/templates.ts'
import type { Workflow } from '../workflow/types.ts'

const DOCS_DIR = join(import.meta.dirname, '..', 'workflow', 'docs')
const DOC_NAME = /^[^/\\\n]{1,64}$/

export type SaveResult = { ok: true; row: ConventionRow } | { ok: false; errors: WorkflowError[] }
export type Resolved =
  | { ok: true; workflow: Workflow; source: string; docs: ConventionDoc[]; used: ConventionsUsed }
  | { ok: false; error: string }

export type WorkflowSummary = ConventionSummary & { description?: string; nodes: string[] }

export const builtinDocs = (): string[] => readdirSync(DOCS_DIR).filter(f => extname(f) === '.md').map(f => basename(f, '.md')).sort()

export class Conventions {
  constructor(private readonly store: Store) {}

  /** 平台上还没有的内置模板和文档写成第 1 版；已有的（包括用户改过的）不动。返回新写入的名字。 */
  seed(at: number): string[] {
    const added: string[] = []
    const put = (kind: ConventionKind, name: string, content: string) => {
      if (this.store.convention(kind, name) !== undefined) return
      this.store.saveConvention({ kind, name, content, note: '内置模板', actor: 'platform' }, at)
      added.push(name)
    }
    for (const name of builtinDocs()) put('doc', name, readFileSync(join(DOCS_DIR, `${name}.md`), 'utf8'))
    for (const name of builtinTemplates()) put('workflow', name, loadWorkflow(name).source)
    return added
  }

  list(kind: 'doc'): ConventionSummary[]
  list(kind: 'workflow'): WorkflowSummary[]
  list(kind: ConventionKind): ConventionSummary[] | WorkflowSummary[] {
    const rows = this.store.conventions(kind)
    if (kind === 'doc') return rows
    return rows.map(r => {
      const parsed = parseWorkflow(this.store.convention('workflow', r.name)!.content)
      // 保存时已经校验过；解析器升级后旧版本可能不再合法，这里不让列表因此出错。
      if (!parsed.ok) return { ...r, nodes: [] }
      const { description, nodes } = parsed.workflow
      return { ...r, ...(description === undefined ? {} : { description }), nodes: nodes.map(n => n.id) }
    })
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
    return kind === 'workflow' ? this.validateWorkflow(name, content) : this.validateDoc(name, content)
  }

  private validateWorkflow(name: string, content: string): WorkflowError[] {
    const r = parseWorkflow(content)
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
      const parsed = parseWorkflow(row.content)
      if (!parsed.ok) return { ok: false, error: `工作流「${row.name}」第 ${row.version} 版无法解析，请在团队约定页修正后再试` }
      ;({ workflow, source } = { workflow: parsed.workflow, source: row.content })
    } else if (existsSync(nameOrPath)) {
      try {
        ;({ workflow, source } = loadWorkflow(nameOrPath))
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
    return {
      ok: true, workflow, source, docs,
      used: { workflow: { name: workflow.name, ...(row === undefined ? {} : { version: row.version }) }, docs: docs.map(d => ({ name: d.name, version: d.version })) },
    }
  }
}
