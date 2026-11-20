// 内置工作流模板，以及按名字或路径加载工作流。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { formatErrors, parseWorkflow } from './parse.ts'
import type { Workflow } from './types.ts'

const DIR = join(import.meta.dirname, 'templates')

export const builtinTemplates = (): string[] =>
  readdirSync(DIR).filter(f => extname(f) === '.yaml').map(f => basename(f, '.yaml')).sort()

/** 内置模板名，或一个 YAML 文件路径。校验失败时抛出带位置的中文错误。 */
export const loadWorkflow = (nameOrPath: string): { workflow: Workflow; source: string } => {
  const builtin = join(DIR, `${nameOrPath}.yaml`)
  const file = existsSync(builtin) ? builtin : nameOrPath
  if (!existsSync(file)) throw new Error(`找不到工作流「${nameOrPath}」。内置模板：${builtinTemplates().join('、')}`)
  const source = readFileSync(file, 'utf8')
  const result = parseWorkflow(source)
  if (!result.ok) throw new Error(`工作流 ${file} 有错误：\n${formatErrors(result.errors)}`)
  return { workflow: result.workflow, source }
}
