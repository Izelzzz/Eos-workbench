import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Conventions } from '../src/conventions/conventions.ts'
import { Proposals } from '../src/improve/proposals.ts'
import { Store } from '../src/store/store.ts'
import type { ProposalInput } from '../src/store/types.ts'
import { builtinAgentSource } from '../src/workflow/templates.ts'

const setup = (path = ':memory:') => {
  const store = new Store(path)
  const c = new Conventions(store)
  c.seed(1)
  return { store, c, p: new Proposals(store, c) }
}

/** 内置 developer 模板的提示词末尾加一行：只改提示词，不动权限字段（批准时会再核对权限）。 */
const DEV = (line: string) => `${builtinAgentSource('developer').trimEnd()}\n  - ${line}\n`

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  target: { kind: 'template', name: 'developer' }, baseVersion: 1, content: DEV('导出函数都写带 @example 的 JSDoc'),
  rationale: '评审两次要求补 @example\n第二行不进备注', evidence: ['t1:9', 't2:9'], scope: { workflow: 'standard', tasks: ['t1', 't2'] },
  generator: { model: 'deepseek-flash', usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, ms: 1200 }, actor: 'cli', ...over,
})

/** 每类约定所有版本的快照：用来断言"没有批准就没有任何约定被改"。 */
const snapshot = (store: Store) => (['workflow', 'doc', 'template', 'skill'] as const).flatMap(k => store.conventions(k).flatMap(s => store.conventionHistory(k, s.name)))

test('a proposal is stored with a pending status and changes no convention until it is approved', () => {
  const { store, p } = setup()
  const before = snapshot(store)
  const r = p.add(input(), 10)
  assert.ok(r.ok, !r.ok ? r.errors.join() : '')
  assert.deepEqual([r.row.id, r.row.status, r.row.events.map(e => [e.status, e.actor, e.at])], [1, 'pending', [['pending', 'cli', 10]]])
  assert.deepEqual(store.proposal(1), r.row, 'everything round-trips through the database')
  assert.deepEqual(snapshot(store), before)
  const rejected = p.reject(1, 11, 'web', '  规则会写进约定文档  ')
  assert.ok(rejected.ok)
  assert.deepEqual(rejected.row.events.at(-1), { seq: 2, at: 11, status: 'rejected', actor: 'web', reason: '规则会写进约定文档' })
  assert.deepEqual(snapshot(store), before, 'a rejected proposal changes nothing either')
})

test('approving writes the new content as the next version, noting the proposal, and records that version', () => {
  const { store, c, p } = setup()
  p.add(input(), 10)
  // 批准之前创建的任务：存进库里，批准后从库里读它的快照。
  const resolved = c.resolve('standard')
  assert.ok(resolved.ok)
  store.create({ id: 'running', request: '需求', workflow: resolved.workflow, workflowSource: resolved.source, docs: resolved.docs,
    meta: { repo: 'r', worktree: 'w', branch: 'b', baseSha: 'x', conventions: resolved.used } }, 11)
  const r = p.approve(1, 20, 'web', '先在 standard 上试')
  assert.ok(r.ok, !r.ok ? r.error : '')
  assert.deepEqual(r.row.events.at(-1), { seq: 2, at: 20, status: 'approved', actor: 'web', version: 2, reason: '先在 standard 上试' }, 'the approval note is kept on the event too')
  const v2 = store.convention('template', 'developer')!
  assert.deepEqual([v2.version, v2.content, v2.actor, v2.note], [2, input().content, 'web', '改进提案 #1：评审两次要求补 @example；先在 standard 上试'])
  // 进行中的任务用创建时的快照；新任务用上新版本。
  const running = store.get('running')!
  assert.equal(running.workflow.roles.developer!.template!.version, 1)
  assert.match(running.workflow.roles.developer!.prompt, /^你是/)
  assert.doesNotMatch(running.workflow.roles.developer!.prompt, /@example/)
  assert.equal(store.meta('running').conventions!.templates!.find(t => t.name === 'developer')!.version, 1)
  const next = c.resolve('standard')
  assert.ok(next.ok)
  assert.deepEqual([next.workflow.roles.developer!.template!.version, next.workflow.roles.developer!.prompt.endsWith('\n- 导出函数都写带 @example 的 JSDoc')], [2, true])
  const again = p.approve(1, 21, 'web')
  assert.deepEqual([again.ok, !again.ok && again.error], [false, '提案 #1 已批准，不能再审批'])
  assert.equal(store.conventionHistory('template', 'developer').length, 2, 'approving twice does not write twice')
})

test('if the target changed after the proposal, approval is refused and the proposal becomes stale', () => {
  const { store, c, p } = setup()
  p.add(input(), 10)
  assert.ok(c.save({ kind: 'template', name: 'developer', content: DEV('别人先改了'), actor: 'web' }, 15).ok)
  const r = p.approve(1, 20, 'web')
  assert.deepEqual([r.ok, !r.ok && r.error], [false, '提案 #1 已过期：目标已是第 2 版，提案基于第 1 版。请重新生成提案'])
  assert.equal(store.proposal(1)!.status, 'stale')
  assert.equal(store.convention('template', 'developer')!.content, DEV('别人先改了'), 'the other edit is kept')
  assert.equal(p.reject(1, 21, 'web', '晚了').ok, false, 'a stale proposal cannot be decided again')
})

test('proposals that cannot be saved, are out of date, change nothing or lack reasons are not stored', () => {
  const { store, p } = setup()
  const bad = (over: Partial<ProposalInput>) => {
    const r = p.add(input(over), 10)
    assert.ok(!r.ok)
    return r.errors
  }
  assert.deepEqual(bad({ target: { kind: 'doc', name: '没有这份' } }), ['平台上没有约定文档「没有这份」'])
  assert.deepEqual(bad({ baseVersion: 3 }), ['提案基于第 3 版，Agent 模板「developer」现在是第 1 版'])
  assert.deepEqual(bad({ content: store.convention('template', 'developer')!.content }), ['新内容和当前版本完全一样'])
  assert.deepEqual(bad({ content: DEV('x').replace('write-changes', 'nope') }), ['新内容不合格：skills[0]：平台上没有名为「nope」的技能'])
  assert.deepEqual(bad({ content: 'name: other\nprompt: x\n' }), ['新内容不合格：name：模板名「other」和要保存的「developer」不一致；要改名请新建一个模板'])
  assert.deepEqual(bad({ rationale: ' ', evidence: [] }), ['缺少理由', '没有引用任何证据'])
  assert.deepEqual(store.proposals(), [])
})

test('approval re-validates: content that no longer saves keeps the proposal pending', () => {
  const { store, p } = setup()
  const wf = store.convention('workflow', 'standard')!
  const r = p.add(input({ target: { kind: 'workflow', name: 'standard' }, content: wf.content.replace('maxRounds: 2', 'maxRounds: 3') }), 10)
  assert.ok(r.ok, !r.ok ? r.errors.join() : '')
  // 提案之后，它引用的模板变得无法解析（直接写库模拟解析器升级后旧版本不合法）。
  store.saveConvention({ kind: 'template', name: 'developer', content: 'name: developer\nprompt: x\nwrite: everywhere\n', note: '', actor: 'test' }, 11)
  const a = p.approve(r.row.id, 12, 'web')
  assert.ok(!a.ok)
  assert.match(a.error, /^新内容现在不能批准：.*developer/)
  assert.equal(store.proposal(r.row.id)!.status, 'pending')
  assert.equal(store.convention('workflow', 'standard')!.version, wf.version)
  // 过期优先：目标本身也被改过时记「已过期」，不会因为内容不合格一直停在待审批。
  store.saveConvention({ kind: 'workflow', name: 'standard', content: wf.content + '\n', note: '', actor: 'test' }, 13)
  const b = p.approve(r.row.id, 14, 'web')
  assert.ok(!b.ok)
  assert.match(b.error, /已过期/)
  assert.equal(store.proposal(r.row.id)!.status, 'stale')
})

test('rejecting needs a reason; unknown proposals are reported; the list is newest first and survives reopening', () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-proposals-'))
  const { store, p } = setup(join(dir, 'eos.db'))
  p.add(input(), 10)
  p.add(input({ rationale: '第二条' }), 11)
  assert.deepEqual(p.reject(1, 12, 'web', ' '), { ok: false, error: '拒绝需要写理由' })
  assert.deepEqual(p.approve(9, 12, 'web'), { ok: false, error: '没有提案 #9' })
  assert.deepEqual(p.reject(9, 12, 'web', '无'), { ok: false, error: '没有提案 #9' })
  store.close()
  const reopened = new Store(join(dir, 'eos.db'))
  assert.deepEqual(reopened.proposals().map(r => [r.id, r.rationale, r.status]), [[2, '第二条', 'pending'], [1, input().rationale, 'pending']])
  assert.deepEqual(reopened.proposal(1)!.generator, input().generator)
  reopened.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a long rationale is cut by code point in the version note, never inside a character', () => {
  const { store, p } = setup()
  p.add(input({ rationale: `${'字'.repeat(78)}😀😀😀` }), 10)
  assert.ok(p.approve(1, 11, 'web').ok)
  const note = store.convention('template', 'developer')!.note
  assert.equal(note, `改进提案 #1：${'字'.repeat(78)}😀…`)
  assert.ok(note.isWellFormed())
})

test('approval checks permissions again and refuses content that changes them, even if it was stored', () => {
  const { store, p } = setup()
  // 绕过 add 的校验直接写库（模拟生成之后权限的展开结果变了）：批准时失败就关。
  const row = store.addProposal(input({ content: builtinAgentSource('developer').replace('  deny: [subagent, schedule]', '  deny: []') }), 10)
  const r = p.approve(row.id, 11, 'web')
  assert.deepEqual(r.ok ? '' : r.error, '新内容现在不能批准：不能改模板的 tools')
  assert.equal(store.proposal(row.id)!.status, 'pending')
  assert.equal(store.convention('template', 'developer')!.version, 1)
})
