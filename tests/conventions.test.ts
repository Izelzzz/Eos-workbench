import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { builtinDocs, Conventions } from '../src/conventions/conventions.ts'
import { Store } from '../src/store/store.ts'
import { builtinTemplates } from '../src/workflow/templates.ts'

const setup = () => {
  const store = new Store(':memory:')
  const c = new Conventions(store)
  c.seed(1)
  return { store, c }
}

const yaml = (docs: string, prompt = '写代码') => `
name: team
docs: [${docs}]
roles:
  dev: { prompt: ${prompt}, write: worktree }
nodes:
  - { id: build, kind: agent, role: dev, task: 实现 }
`

test('seeding writes every built-in once as version 1 and never overwrites a team edit', () => {
  const { store, c } = setup()
  assert.deepEqual(c.list('workflow').map(w => [w.name, w.version]), builtinTemplates().map(n => [n, 1]))
  assert.deepEqual(c.list('doc').map(d => d.name), builtinDocs())
  const doc = builtinDocs()[0]!
  assert.ok(c.save({ kind: 'doc', name: doc, content: '团队改过的版本', actor: 'web' }, 2).ok)
  assert.deepEqual(c.seed(3), [], 'nothing new to seed')
  assert.equal(store.convention('doc', doc)?.content, '团队改过的版本')
  assert.equal(store.convention('doc', doc)?.version, 2)
})

test('every save is a new version; old versions stay readable', () => {
  const { store, c } = setup()
  const first = c.save({ kind: 'doc', name: '评审约定', content: 'v1', note: '初版', actor: 'web' }, 10)
  const second = c.save({ kind: 'doc', name: '评审约定', content: 'v2', actor: 'web' }, 20)
  assert.ok(first.ok && second.ok)
  assert.deepEqual(store.conventionHistory('doc', '评审约定').map(r => [r.version, r.content, r.note, r.createdAt]), [[2, 'v2', '', 20], [1, 'v1', '初版', 10]])
  assert.equal(store.convention('doc', '评审约定', 1)?.content, 'v1')
  const same = c.save({ kind: 'doc', name: '评审约定', content: 'v2', actor: 'web' }, 30)
  assert.equal(same.ok, false, 'unchanged content is not a new version')
})

test('saving a workflow validates YAML, its name, and that its docs exist, in Chinese with locations', () => {
  const { c } = setup()
  const bad = c.save({ kind: 'workflow', name: 'team', content: yaml('不存在的文档'), actor: 'web' }, 1)
  assert.deepEqual(!bad.ok && bad.errors, [{ path: 'docs[0]', message: '平台上没有名为「不存在的文档」的约定文档' }])
  const renamed = c.save({ kind: 'workflow', name: 'other', content: yaml(''), actor: 'web' }, 1)
  assert.equal(!renamed.ok && renamed.errors[0]?.path, 'name')
  const broken = c.save({ kind: 'workflow', name: 'team', content: 'name: team\nroles: [', actor: 'web' }, 1)
  assert.match(!broken.ok ? broken.errors[0]!.message : '', /YAML 格式错误/)
  const docName = c.save({ kind: 'doc', name: 'a/b', content: 'x', actor: 'web' }, 1)
  assert.equal(!docName.ok && docName.errors[0]?.path, 'name')
  assert.ok(c.save({ kind: 'workflow', name: 'team', content: yaml(builtinDocs()[0]!), actor: 'web' }, 1).ok)
})

test('resolve snapshots the latest workflow and docs and records their versions', () => {
  const { c } = setup()
  const doc = builtinDocs()[0]!
  c.save({ kind: 'doc', name: doc, content: '第二版约定', actor: 'web' }, 2)
  c.save({ kind: 'workflow', name: 'team', content: yaml(doc), actor: 'web' }, 3)
  c.save({ kind: 'workflow', name: 'team', content: yaml(doc, '写更好的代码'), actor: 'web' }, 4)
  const r = c.resolve('team')
  assert.ok(r.ok)
  assert.equal(r.workflow.roles.dev?.prompt, '写更好的代码')
  assert.deepEqual(r.docs, [{ name: doc, version: 2, content: '第二版约定' }])
  assert.deepEqual(r.used, { workflow: { name: 'team', version: 2 }, docs: [{ name: doc, version: 2 }], templates: [], skills: [] })
})

test('resolve falls back to a YAML file path, still taking docs from the platform', () => {
  const { c } = setup()
  const file = join(mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-conv-')), 'wf.yaml')
  writeFileSync(file, yaml(builtinDocs()[0]!))
  const r = c.resolve(file)
  assert.ok(r.ok)
  assert.deepEqual(r.used.workflow, { name: 'team' })
  assert.equal(r.docs.length, 1)
  const missing = c.resolve('nope')
  assert.match(!missing.ok ? missing.error : '', /平台上没有工作流「nope」/)
})

test('two processes seeding the same database write each built-in only once', () => {
  const store = new Store(':memory:')
  new Conventions(store).seed(1)
  new Conventions(store).seed(2)
  assert.deepEqual(store.conventionHistory('workflow', 'standard').map(r => r.version), [1])
})

test('templates and skills are seeded, validated against each other, and snapshotted into tasks with their versions', () => {
  const { store, c } = setup()
  assert.deepEqual(c.list('template').map(t => [t.name, t.version, t.write]), [['developer', 1, 'worktree'], ['improver', 1, 'none'], ['reviewer', 1, 'none'], ['spec-writer', 1, 'worktree']])
  assert.deepEqual(c.list('skill').map(k => k.name), ['write-changes'])

  const missingSkill = c.save({ kind: 'template', name: 'helper', content: 'name: helper\nprompt: 帮忙\nskills: [no-such-skill]\n', actor: 'web' }, 2)
  assert.deepEqual(!missingSkill.ok && missingSkill.errors, [{ path: 'skills[0]', message: '平台上没有名为「no-such-skill」的技能' }])
  const renamedSkill = c.save({ kind: 'skill', name: 'other', content: '---\nname: write-changes\ndescription: x\n---\n正文', actor: 'web' }, 2)
  assert.equal(!renamedSkill.ok && renamedSkill.errors[0]!.path, 'name')

  assert.ok(c.save({ kind: 'skill', name: 'write-changes', content: '---\nname: write-changes\ndescription: 新写法\n---\n第二版', actor: 'web' }, 3).ok)
  assert.ok(c.save({ kind: 'template', name: 'developer', content: 'name: developer\nprompt: 第二版开发\nwrite: worktree\nwritePaths: [src/**]\nskills: [write-changes]\n', actor: 'web' }, 4).ok)
  const wf = 'name: team\nroles:\n  rev: { template: reviewer }\n  dev: { template: developer }\nnodes:\n  - { id: build, kind: agent, role: dev, task: 实现 }\n  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }\n'
  assert.ok(c.save({ kind: 'workflow', name: 'team', content: wf, actor: 'web' }, 5).ok)
  const r = c.resolve('team')
  assert.ok(r.ok, !r.ok ? r.error : '')
  assert.equal(r.workflow.roles.dev?.prompt, '第二版开发')
  assert.deepEqual(r.used.templates, [{ name: 'developer', version: 2 }, { name: 'reviewer', version: 1 }], 'sorted by name, not by role order')
  assert.deepEqual(r.skills, [{ name: 'write-changes', version: 2, content: '---\nname: write-changes\ndescription: 新写法\n---\n第二版' }])
  assert.deepEqual(r.used.skills, [{ name: 'write-changes', version: 2 }])

  const ghost = c.save({ kind: 'workflow', name: 'ghosts', content: wf.replace('name: team', 'name: ghosts').replace('template: reviewer', 'template: nobody'), actor: 'web' }, 6)
  assert.deepEqual(!ghost.ok && ghost.errors, [{ path: 'roles.rev.template', message: '平台上没有名为「nobody」的 Agent 模板' }])
  assert.equal(store.conventionHistory('template', 'developer').length, 2)
})
