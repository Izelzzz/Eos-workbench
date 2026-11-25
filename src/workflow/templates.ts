// 内置的工作流、Agent 模板和技能（平台上没有时写成第 1 版），以及按名字或路径加载工作流。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parseSkill, parseTemplate } from './agent.ts'
import { formatErrors, parseWorkflow } from './parse.ts'
import type { AgentTemplate, TemplateLookup, Workflow } from './types.ts'

const DIR = join(import.meta.dirname, 'templates')
const AGENTS_DIR = join(import.meta.dirname, 'agents')
const SKILLS_DIR = join(import.meta.dirname, 'skills')

const namesIn = (dir: string, ext: string) =>
  readdirSync(dir)
    .filter(f => extname(f) === ext)
    .map(f => basename(f, ext))
    .sort()

export const builtinAgentTemplates = (): string[] => namesIn(AGENTS_DIR, '.yaml')
export const builtinSkills = (): string[] => namesIn(SKILLS_DIR, '.md')

export const builtinAgentSource = (name: string): string => readFileSync(join(AGENTS_DIR, `${name}.yaml`), 'utf8')
export const builtinSkillSource = (name: string): string => readFileSync(join(SKILLS_DIR, `${name}.md`), 'utf8')

/** 内置 Agent 模板，按第 1 版查找：校验内置工作流、平台还没有种子数据时用。解析失败直接抛错（内置文件写错是代码 bug）。 */
export const builtinLookup = (): TemplateLookup => {
  const byName = new Map<string, AgentTemplate>()
  for (const name of builtinAgentTemplates()) {
    const r = parseTemplate(builtinAgentSource(name))
    if (!r.ok) throw new Error(`内置 Agent 模板 ${name} 有错误：\n${formatErrors(r.errors)}`)
    byName.set(name, r.template)
  }
  return name => {
    const template = byName.get(name)
    return template === undefined ? undefined : { template, version: 1 }
  }
}

/** 内置技能都合法（测试用）；解析失败直接抛错。 */
export const checkBuiltinSkills = (): void => {
  for (const name of builtinSkills()) {
    const r = parseSkill(builtinSkillSource(name))
    if (!r.ok) throw new Error(`内置技能 ${name} 有错误：\n${formatErrors(r.errors)}`)
    if (r.skill.name !== name) throw new Error(`内置技能文件 ${name}.md 里的 name 是 ${r.skill.name}`)
  }
}

export const builtinTemplates = (): string[] =>
  readdirSync(DIR)
    .filter(f => extname(f) === '.yaml')
    .map(f => basename(f, '.yaml'))
    .sort()

/** 内置模板名，或一个 YAML 文件路径。校验失败时抛出带位置的中文错误。 */
export const loadWorkflow = (nameOrPath: string, lookup: TemplateLookup = builtinLookup()): { workflow: Workflow; source: string } => {
  const builtin = join(DIR, `${nameOrPath}.yaml`)
  const file = existsSync(builtin) ? builtin : nameOrPath
  if (!existsSync(file)) throw new Error(`找不到工作流「${nameOrPath}」。内置模板：${builtinTemplates().join('、')}`)
  const source = readFileSync(file, 'utf8')
  const result = parseWorkflow(source, lookup)
  if (!result.ok) throw new Error(`工作流 ${file} 有错误：\n${formatErrors(result.errors)}`)
  return { workflow: result.workflow, source }
}
