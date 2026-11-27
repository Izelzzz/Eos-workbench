// Agent 模板、技能和工作流里的模板引用。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSkill, parseTemplate } from '../src/workflow/agent.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import { builtinAgentTemplates, builtinLookup, builtinSkills, checkBuiltinSkills, loadWorkflow } from '../src/workflow/templates.ts'
import type { TemplateLookup } from '../src/workflow/types.ts'

const template = `
name: developer
description: 开发
write: worktree
writePaths: [src/**, tests/**]
tools: { deny: [web, subagent] }
skills: [write-changes]
mcp:
  - { name: docs, command: node, args: [server.mjs], env: { LOG_LEVEL: info } }
prompt: 写代码
`

test('a template parses into an agent config with defaults filled in', () => {
  const r = parseTemplate(template)
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors))
  assert.deepEqual(r.template, {
    name: 'developer',
    description: '开发',
    model: 'deepseek-flash',
    prompt: '写代码',
    write: 'worktree',
    writePaths: ['src/**', 'tests/**'],
    denyTools: ['web', 'subagent'],
    skills: ['write-changes'],
    mcp: [{ name: 'docs', command: 'node', args: ['server.mjs'], env: { LOG_LEVEL: 'info' } }],
  })
  const minimal = parseTemplate('name: dev\nprompt: 写代码\nwrite: worktree\n')
  assert.ok(minimal.ok)
  assert.deepEqual(
    [minimal.template.writePaths, minimal.template.denyTools, minimal.template.skills, minimal.template.mcp],
    [['**'], [], [], []],
    'a writer without writePaths may write the whole worktree',
  )
  const reader = parseTemplate('name: rev\nprompt: 评审\n')
  assert.ok(reader.ok)
  assert.deepEqual(reader.template.writePaths, [], 'a read-only template writes nothing')
})

test('template errors are in Chinese with their location', () => {
  const errorsOf = (src: string) => {
    const r = parseTemplate(src)
    assert.equal(r.ok, false)
    return Object.fromEntries((r.ok ? [] : r.errors).map(e => [e.path, e.message]))
  }
  const e1 = errorsOf(template.replace('[web, subagent]', '[web, browser]').replace('src/**', '../src/**'))
  assert.match(e1['tools.deny[1]']!, /只能是 web、subagent、bash、schedule、todo、goal 之一/)
  assert.match(e1['writePaths[0]']!, /worktree 内的相对路径/)
  const e2 = errorsOf(template.replace('LOG_LEVEL: info', 'API_KEY: sk-123').replace('write: worktree', 'write: none'))
  assert.match(e2['mcp[0].env.API_KEY']!, /不能放密钥/)
  assert.match(e2.writePaths!, /只读（write: none）的角色不需要 writePaths/)
  const e3 = errorsOf(template.replace('name: docs', 'name: two words'))
  assert.match(e3['mcp[0].name']!, /只能用字母、数字/)
  assert.match(errorsOf('name: x\nprompt: [\n')['第 3 行'] ?? Object.values(errorsOf('name: x\nprompt: [\n'))[0]!, /YAML 格式错误/)
})

test('a skill is Markdown with name and description between --- lines', () => {
  const ok = parseSkill('---\nname: write-changes\ndescription: 写改动说明时使用\n---\n# 写法\n内容')
  assert.deepEqual(ok, { ok: true, skill: { name: 'write-changes', description: '写改动说明时使用', body: '# 写法\n内容' } })
  const noHead = parseSkill('# 只有正文')
  assert.match(!noHead.ok ? noHead.errors[0]!.message : '', /要以 --- 开头/)
  const badName = parseSkill('---\nname: Write Changes\ndescription: x\n---\n正文')
  assert.equal(!badName.ok && badName.errors[0]!.path, 'name')
  const empty = parseSkill('---\nname: a\ndescription: x\n---\n  \n')
  assert.match(!empty.ok ? empty.errors[0]!.message : '', /正文不能为空/)
})

const workflowWith = (role: string) => `
name: w
roles:
  dev: ${role}
nodes:
  - { id: build, kind: agent, role: dev, task: 实现 }
`

test('a workflow role can reference a template; the resolved role records which template version it came from', () => {
  const t = parseTemplate(template)
  assert.ok(t.ok)
  const lookup: TemplateLookup = name => (name === 'developer' ? { template: t.template, version: 3 } : undefined)
  const r = parseWorkflow(workflowWith('{ template: developer }'), lookup)
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors))
  assert.deepEqual(r.workflow.roles.dev, {
    id: 'dev',
    model: 'deepseek-flash',
    prompt: '写代码',
    write: 'worktree',
    writePaths: ['src/**', 'tests/**'],
    denyTools: ['web', 'subagent'],
    skills: ['write-changes'],
    mcp: [{ name: 'docs', command: 'node', args: ['server.mjs'], env: { LOG_LEVEL: 'info' } }],
    template: { name: 'developer', version: 3 },
  })
  const missing = parseWorkflow(workflowWith('{ template: ghost }'), lookup)
  assert.deepEqual(!missing.ok && missing.errors, [{ path: 'roles.dev.template', message: '平台上没有名为「ghost」的 Agent 模板' }])
  const mixed = parseWorkflow(workflowWith('{ template: developer, prompt: 改一下 }'), lookup)
  assert.deepEqual(!mixed.ok && mixed.errors, [{ path: 'roles.dev', message: '不认识的字段：prompt' }], 'a template reference has no other fields')
})

test('an inline role takes the same fields as a template, and its errors are reported with the rest of the workflow', () => {
  const r = parseWorkflow(workflowWith('{ prompt: 写代码, write: worktree, writePaths: [src/**], tools: { deny: [bash] } }'))
  assert.ok(r.ok)
  assert.deepEqual([r.workflow.roles.dev?.writePaths, r.workflow.roles.dev?.denyTools, r.workflow.roles.dev?.template], [['src/**'], ['bash'], undefined])
  const both = parseWorkflow(workflowWith('{ prompt: 写代码, write: anywhere }').replace('task: 实现', 'task: 实现, maxFixes: -1'))
  assert.deepEqual(!both.ok && both.errors.map(e => e.path).sort(), ['nodes[0].maxFixes', 'roles.dev.write'])
})

test('built-in templates and skills are valid, and built-in workflows resolve against them', () => {
  assert.deepEqual(builtinAgentTemplates(), ['assistant', 'developer', 'improver', 'reviewer', 'spec-writer'])
  assert.deepEqual(builtinSkills(), ['write-changes'])
  assert.doesNotThrow(checkBuiltinSkills)
  const lookup = builtinLookup()
  for (const name of builtinAgentTemplates()) assert.equal(lookup(name)?.version, 1)
  assert.doesNotThrow(() => loadWorkflow('standard'))
})

test('a value of the wrong type gets the field’s own Chinese message, not “missing field”', () => {
  const byPath = (src: string) => {
    const r = parseTemplate(src)
    assert.equal(r.ok, false)
    return Object.fromEntries((r.ok ? [] : r.errors).map(e => [e.path, e.message]))
  }
  assert.match(byPath('name: dev\nprompt: x\nwrite: worktree\nwritePaths: src/**\n').writePaths!, /必须是路径列表，例如 \[src\/\*\*, tests\/\*\*\]/)
  assert.match(byPath('name: dev\nprompt: x\ntools: [bash]\n').tools!, /必须是对象，例如 \{ deny: \[web, subagent\] \}/)
  assert.match(byPath('name: dev\nprompt: x\ntools: { deny: web }\n')['tools.deny']!, /必须是列表/)
  assert.equal(byPath('name: dev\n').prompt, '缺少这个字段', 'a missing field is still reported as missing')
  assert.match(byPath('name: dev\nprompt: x\nwrite: worktree\nwritePaths: [src\\\\a.ts]\n')['writePaths[0]']!, /反斜杠/)
})
