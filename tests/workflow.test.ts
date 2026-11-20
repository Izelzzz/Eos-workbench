import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseWorkflow } from '../src/workflow/parse.ts'
import { builtinTemplates, loadWorkflow } from '../src/workflow/templates.ts'

const base = `
name: demo
roles:
  dev: { prompt: 写代码, write: worktree }
  rev: { prompt: 审代码 }
nodes:
  - { id: build, kind: agent, role: dev, task: 实现 }
  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }
`

const errorsOf = (src: string) => {
  const r = parseWorkflow(src)
  assert.equal(r.ok, false, 'expected validation errors')
  return r.ok ? [] : r.errors
}

test('fills defaults: model deepseek-flash, write none, 5 rounds, no inputs', () => {
  const r = parseWorkflow(base)
  assert.ok(r.ok)
  assert.equal(r.workflow.roles.rev?.model, 'deepseek-flash')
  assert.equal(r.workflow.roles.rev?.write, 'none')
  const review = r.workflow.nodes[1]
  assert.equal(review?.kind, 'dialog')
  assert.equal(review?.kind === 'dialog' && review.maxRounds, 5)
  assert.deepEqual(r.workflow.nodes[0]?.inputs, [])
})

test('every built-in template is valid', () => {
  assert.ok(builtinTemplates().includes('feature'))
  for (const name of builtinTemplates()) assert.doesNotThrow(() => loadWorkflow(name), name)
})

test('reports YAML syntax errors with a line number', () => {
  const [e] = errorsOf('name: demo\nroles: [\n')
  assert.match(e!.path, /第 \d+ 行/)
  assert.match(e!.message, /YAML 格式错误/)
})

test('reports a missing field and an unknown field at their paths', () => {
  const errors = errorsOf(base.replace('prompt: 审代码', 'promt: 审代码'))
  assert.deepEqual(errors.map(e => e.path).sort(), ['roles.rev', 'roles.rev.prompt'])
  assert.ok(errors.some(e => e.message.includes('不认识的字段：promt')))
  assert.ok(errors.some(e => e.message === '缺少这个字段'))
})

test('rejects bad enums and round limits in Chinese', () => {
  const errors = errorsOf(base.replace('write: worktree', 'write: everywhere').replace('task: 评审', 'task: 评审, maxRounds: 0'))
  assert.ok(errors.some(e => e.path === 'roles.dev.write' && e.message.includes('none 或 worktree')))
  assert.ok(errors.some(e => e.path === 'nodes[1].maxRounds' && e.message === '至少 1 轮'))
})

test('rejects references to unknown roles and to later or non-agent nodes', () => {
  const src = `
name: demo
roles:
  a: { prompt: x }
nodes:
  - { id: first, kind: agent, role: ghost, task: t, inputs: [later] }
  - { id: talk, kind: dialog, role: a, with: later, task: t }
  - { id: later, kind: agent, role: a, task: t }
  - { id: talk2, kind: dialog, role: a, with: later, escalate: talk, task: t }
  - { id: later, kind: agent, role: a, task: t }
`
  const byPath = Object.fromEntries(errorsOf(src).map(e => [e.path, e.message]))
  assert.equal(byPath['nodes[0].role'], '没有名为「ghost」的角色')
  assert.equal(byPath['nodes[0].inputs[0]'], '「later」必须是排在前面的节点')
  assert.equal(byPath['nodes[1].with'], '「later」必须是排在前面的节点')
  assert.equal(byPath['nodes[3].escalate'], '「talk」必须是 agent 节点')
  assert.equal(byPath['nodes[4].id'], '节点 id「later」重复')
})

test('escalating to the reviewed node itself is rejected', () => {
  const errors = errorsOf(base.replace('task: 评审', 'task: 评审, escalate: build'))
  assert.deepEqual(errors, [{ path: 'nodes[1].escalate', message: '重新确认的对象不能是被评审的节点本身' }])
})
