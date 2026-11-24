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

const withChecks = `
name: std
docs: [研发约定]
roles:
  planner: { prompt: 写规格, write: worktree }
  dev: { prompt: 写代码, write: worktree }
  rev: { prompt: 评审 }
nodes:
  - id: spec
    kind: agent
    role: planner
    task: 写规格
    deliverables:
      - { path: docs/spec.md, sections: [背景, 验收标准] }
  - { id: build, kind: agent, role: dev, task: 实现, maxFixes: 1, checks: [{ run: [npm, run, lint] }] }
  - { id: test, kind: dialog, with: build, task: 跑测试, checks: [{ run: [npm, test], timeoutSec: 120 }] }
  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }
`

test('deliverables and command checks become one list of checks; dialogs may check without a reviewer', () => {
  const r = parseWorkflow(withChecks)
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors))
  assert.deepEqual(r.workflow.docs, ['研发约定'])
  const [spec, build, testNode, review] = r.workflow.nodes
  assert.deepEqual(spec?.checks, [{ kind: 'file', path: 'docs/spec.md', sections: ['背景', '验收标准'] }])
  assert.equal(spec?.kind === 'agent' && spec.maxFixes, 2, 'default maxFixes')
  assert.deepEqual(build?.checks, [{ kind: 'run', run: ['npm', 'run', 'lint'], timeoutSec: 600 }])
  assert.equal(build?.kind === 'agent' && build.maxFixes, 1)
  assert.equal(testNode?.kind === 'dialog' && testNode.role, undefined)
  assert.deepEqual(testNode?.checks, [{ kind: 'run', run: ['npm', 'test'], timeoutSec: 120 }])
  assert.deepEqual(review?.checks, [])
})

test('平台动作 { platform: push } 解析成检查；位置不对、不认识的动作、多余的字段报中文原因', () => {
  const ship = (checks: string) => `${withChecks}  - { id: ship, kind: dialog, with: build, task: 交付, checks: ${checks} }\n`
  const r = parseWorkflow(ship('[{ run: [npm, test] }, { platform: push }]'))
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors))
  assert.deepEqual(r.workflow.nodes[4]?.checks, [{ kind: 'run', run: ['npm', 'test'], timeoutSec: 600 }, { kind: 'platform', action: 'push' }])
  // 只能在评审之后、没有评审角色的对话节点里，排在命令检查后面。
  const misplaced = [
    [ship('[{ platform: push }, { run: [npm, test] }]'), 'nodes[4].checks', /要排在命令检查后面/],
    [withChecks.replace('checks: [{ run: [npm, run, lint] }]', 'checks: [{ platform: push }]'), 'nodes[1].checks', /只能放在没有评审角色的对话节点里/],
    [withChecks.replace('{ id: review, kind: dialog, role: rev, with: build, task: 评审 }', '{ id: review, kind: dialog, role: rev, with: build, task: 评审, checks: [{ platform: push }] }'), 'nodes[3].checks', /只能放在没有评审角色的对话节点里/],
    [withChecks.replace('checks: [{ run: [npm, test], timeoutSec: 120 }]', 'checks: [{ run: [npm, test], timeoutSec: 120 }, { platform: push }]'), 'nodes[2].checks', /前面要有带评审角色的对话节点/],
  ] as const
  for (const [text, path, message] of misplaced) {
    const errors = errorsOf(text)
    assert.ok(errors.some(e => e.path === path && message.test(e.message)), JSON.stringify(errors))
  }
  for (const bad of ['{ platform: deploy }', '{ platform: push, run: [x] }', '{ push: true }']) {
    const errors = errorsOf(ship(`[${bad}]`))
    assert.ok(errors.some(e => e.path === 'nodes[4].checks[0]' && /必须是命令检查 \{ run: \[npm, test\] \} 或平台动作 \{ platform: push \}/.test(e.message)), `${bad}：${JSON.stringify(errors)}`)
  }
})

test('a dialog needs a reviewer or checks, and deliverable paths must stay inside the worktree', () => {
  const src = withChecks
    .replace("{ id: test, kind: dialog, with: build, task: 跑测试, checks: [{ run: [npm, test], timeoutSec: 120 }] }", '{ id: test, kind: dialog, with: build, task: 跑测试 }')
    .replace('path: docs/spec.md', 'path: ../outside.md')
  const byPath = Object.fromEntries(errorsOf(src).map(e => [e.path, e.message]))
  assert.match(byPath['nodes[0].deliverables[0].path']!, /worktree 内的相对路径/)
  // 结构错误会先报；修好路径再看语义错误
  const semanticOnly = Object.fromEntries(errorsOf(src.replace('path: ../outside.md', 'path: docs/spec.md')).map(e => [e.path, e.message]))
  assert.match(semanticOnly['nodes[2].role']!, /至少要有评审角色/)
})

test('absolute paths and empty commands are rejected in Chinese', () => {
  const errors = errorsOf(withChecks.replace('path: docs/spec.md', 'path: /etc/passwd').replace('run: [npm, run, lint]', 'run: []'))
  assert.ok(errors.some(e => e.path === 'nodes[0].deliverables[0].path'))
  assert.ok(errors.some(e => e.path === 'nodes[1].checks[0].run' && e.message === '命令不能为空'))
})

test('a deliverable on a read-only role is rejected: it could never write the file', () => {
  const errors = errorsOf(withChecks.replace('planner: { prompt: 写规格, write: worktree }', 'planner: { prompt: 写规格, write: none }'))
  assert.deepEqual(errors, [{ path: 'nodes[0].deliverables', message: '角色「planner」只读（write: none），写不出交付物文件；把它的 write 改成 worktree' }])
})

test('交付物不在产出它的角色的可写范围内时报错：写了会被撤销，检查永远过不了', () => {
  const errors = errorsOf(withChecks.replace('planner: { prompt: 写规格, write: worktree }', 'planner: { prompt: 写规格, write: worktree, writePaths: [specs/**] }'))
  assert.deepEqual(errors, [{ path: 'nodes[0].deliverables', message: '交付物「docs/spec.md」不在角色「planner」的可写范围（specs/**）内，写了会被撤销；把它加进 writePaths，或换一个范围内的路径' }])
  // 对话节点的交付物由被评审的节点产出。
  const dialog = errorsOf(withChecks
    .replace('dev: { prompt: 写代码, write: worktree }', 'dev: { prompt: 写代码, write: worktree, writePaths: [src/**] }')
    .replace("checks: [{ run: [npm, test], timeoutSec: 120 }] }", "checks: [{ run: [npm, test], timeoutSec: 120 }], deliverables: [{ path: docs/changes.md }] }"))
  assert.deepEqual(dialog.map(e => e.path), ['nodes[2].deliverables'])
  assert.equal(parseWorkflow(withChecks.replace('planner: { prompt: 写规格, write: worktree }', 'planner: { prompt: 写规格, write: worktree, writePaths: [docs/**] }')).ok, true)
})

test('对话节点的交付物由被评审的节点产出：那个角色只读时同样报错', () => {
  const errors = errorsOf(withChecks
    .replace('dev: { prompt: 写代码, write: worktree }', 'dev: { prompt: 写代码, write: none }')
    .replace("checks: [{ run: [npm, test], timeoutSec: 120 }] }", "checks: [{ run: [npm, test], timeoutSec: 120 }], deliverables: [{ path: docs/changes.md }] }"))
  assert.deepEqual(errors, [{ path: 'nodes[2].deliverables', message: '角色「dev」只读（write: none），写不出交付物文件；把它的 write 改成 worktree' }])
})
