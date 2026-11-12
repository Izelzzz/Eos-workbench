import { expect, test } from 'claude-code/testing'

import { blocksPreload, skillFileCandidates, skillPlan, stageAgents } from '../hooks/core/config'
import { withReadFirst } from '../hooks/core/prompts'

test('阶段配置：stages 优先，models 兜底，最后是默认值；写错类型的字段当作没写', () => {
  expect(stageAgents({})).toEqual({
    spec: { model: 'inherit', skills: [] },
    dev: { model: 'inherit', skills: [] },
    review: { model: 'sonnet', skills: [] },
  })
  const raw = {
    models: { developer: 'sonnet', reviewer: 'opus' },
    stages: { dev: { model: 'opus', effort: 'high', skills: ['pstack:poteto-mode', 3, ''] }, review: { effort: 2000, skills: 'x' } },
  }
  expect(stageAgents(raw as unknown as Parameters<typeof stageAgents>[0])).toEqual({
    spec: { model: 'inherit', skills: [] },
    dev: { model: 'opus', effort: 'high', skills: ['pstack:poteto-mode'] },
    review: { model: 'opus', effort: 2000, skills: [] },
  })
})

test('skill 文件：插件 skill 按 installed_plugins.json 找，项目 skill 先找仓库再找用户目录', () => {
  const installed = { plugins: { 'pstack@cursor-plugins': [{ installPath: '/h/.claude/plugins/cache/cursor-plugins/pstack/0.15.36' }], 'other@m': [] } }
  expect(skillFileCandidates('pstack:poteto-mode', installed, '/h', '/repo')).toEqual([
    '/h/.claude/plugins/cache/cursor-plugins/pstack/0.15.36/skills/poteto-mode/SKILL.md',
  ])
  expect(skillFileCandidates('engineering:code-review', installed, '/h', '/repo')).toEqual([])
  expect(skillFileCandidates('verify', undefined, '/h', '/repo')).toEqual(['/repo/.claude/skills/verify/SKILL.md', '/h/.claude/skills/verify/SKILL.md'])
})

test('disable-model-invocation 的 skill 改为先读，其余预加载；找不到文件的照常预加载', () => {
  const blocked = '---\nname: a\ndisable-model-invocation: true\n---\n# A\n'
  const open = '---\nname: b\n---\n# B\ndisable-model-invocation: true\n'
  expect(blocksPreload(blocked)).toBe(true)
  expect(blocksPreload(open)).toBe(false)
  const plan = skillPlan(['p:a', 'p:b', 'q:c'], { 'p:a': { path: '/a/SKILL.md', text: blocked }, 'p:b': { path: '/b/SKILL.md', text: open } })
  expect(plan).toEqual({ preload: ['p:b', 'q:c'], readFirst: ['/a/SKILL.md'] })
  expect(withReadFirst('任务', plan.readFirst)).toBe('先完整阅读并遵循 /a/SKILL.md\n\n任务')
  expect(withReadFirst('任务', [])).toBe('任务')
})
