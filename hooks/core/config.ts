// 子 agent 阶段的配置：模型、effort、skill，以及哪些 skill 不能预加载、要改成在提示词里要求先读。纯函数。
import type { DevbenchConfig, StageAgentConfig } from '../../types'

export type AgentStage = 'spec' | 'dev' | 'review'

export const AGENT_STAGES: readonly AgentStage[] = ['spec', 'dev', 'review']

/** models 字段沿用的角色名。 */
export const ROLE: Record<AgentStage, 'planner' | 'developer' | 'reviewer'> = {
  spec: 'planner',
  dev: 'developer',
  review: 'reviewer',
}

const DEFAULT_MODEL: Record<AgentStage, string> = { spec: 'inherit', dev: 'inherit', review: 'sonnet' }

export type StageAgent = { model: string; effort?: string | number; skills: string[] }

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/** .devbench.json 是手写的：类型不对的字段当作没写，而不是让阶段启动失败。 */
const parseStage = (raw: unknown): StageAgentConfig => {
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const effort = typeof r.effort === 'number' ? r.effort : text(r.effort)
  const skills = Array.isArray(r.skills) ? r.skills.map(text).filter((s): s is string => s !== undefined) : undefined
  return { model: text(r.model), ...(effort === undefined ? {} : { effort }), ...(skills === undefined ? {} : { skills }) }
}

/** stages.<阶段>.model 优先，其次 models.<角色>，最后是默认值。 */
export const stageAgents = (raw: Pick<DevbenchConfig, 'models' | 'stages'>): Record<AgentStage, StageAgent> => {
  const stages = (typeof raw.stages === 'object' && raw.stages !== null ? raw.stages : {}) as Record<string, unknown>
  return Object.fromEntries(
    AGENT_STAGES.map(id => {
      const own = parseStage(stages[id])
      const model = own.model ?? text(raw.models?.[ROLE[id]]) ?? DEFAULT_MODEL[id]
      return [id, { model, ...(own.effort === undefined ? {} : { effort: own.effort }), skills: own.skills ?? [] }]
    }),
  ) as Record<AgentStage, StageAgent>
}

/**
 * skill 名对应的 SKILL.md：`插件:skill` 从 installed_plugins.json 找插件的安装目录，
 * 不带插件名的找项目的 .claude/skills，再找用户的 ~/.claude/skills。返回候选路径，按顺序取第一个存在的。
 */
export const skillFileCandidates = (name: string, installed: unknown, home: string | undefined, root: string): string[] => {
  const [plugin, skill] = name.includes(':') ? name.split(':', 2) as [string, string] : [undefined, name]
  if (plugin === undefined) {
    return [`${root}/.claude/skills/${skill}/SKILL.md`, ...(home === undefined ? [] : [`${home}/.claude/skills/${skill}/SKILL.md`])]
  }
  const plugins = (installed as { plugins?: Record<string, { installPath?: unknown }[]> } | undefined)?.plugins ?? {}
  return Object.entries(plugins)
    .filter(([key]) => key.split('@')[0] === plugin)
    .flatMap(([, installs]) => (Array.isArray(installs) ? installs : []))
    .map(i => i.installPath)
    .filter((p): p is string => typeof p === 'string')
    .map(p => `${p}/skills/${skill}/SKILL.md`)
}

/** frontmatter 里写了 disable-model-invocation: true 的 skill 不会被预加载进子 agent（见 README 的探测结果）。 */
export const blocksPreload = (skillMd: string): boolean => {
  const front = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? ''
  return /^disable-model-invocation:\s*true\s*$/m.test(front)
}

export type SkillPlan = { preload: string[]; readFirst: string[] }

/** 能预加载的交给 AgentSpec.skills；不能的改成提示词里的「先完整阅读并遵循」。找不到文件的照常预加载。 */
export const skillPlan = (skills: string[], files: Record<string, { path: string; text: string } | undefined>): SkillPlan => {
  const preload: string[] = []
  const readFirst: string[] = []
  for (const name of skills) {
    const file = files[name]
    if (file !== undefined && blocksPreload(file.text)) readFirst.push(file.path)
    else preload.push(name)
  }
  return { preload, readFirst }
}
