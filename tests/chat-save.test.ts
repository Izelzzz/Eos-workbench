import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Chats, MCP_NAME, type ChatOptions } from '../src/chat/chat.ts'
import { chatCommand } from '../src/chat/cli.ts'
import { PROPOSE_TOOL } from '../src/chat/proposals.ts'
import { saveProposal } from '../src/chat/save.ts'
import { ChatStore } from '../src/chat/store.ts'
import type { DataSource } from '../src/chat/tools.ts'
import { TOOLS } from '../src/chat/tools.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { redactText } from '../src/credentials/redact.ts'
import { Store } from '../src/store/store.ts'
import { loadWorkflow } from '../src/workflow/templates.ts'
import { McpExecutor, type McpScript } from './mcp-executor.ts'

// 运行时拼出来：源码里不出现像 key 的整串字面量（gitleaks）。
const SECRET = ['sk', 'save', 'test', '0123456789', 'secret'].join('-')
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const platform = () => {
  const dir = mkdtempSync(join(tmpdir(), 'eos-save-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'eos.db'))
  const conventions = new Conventions(store)
  conventions.seed(1)
  const wf = loadWorkflow('standard', conventions.lookup())
  store.create({ id: 't1', request: '补测试', workflow: wf.workflow, workflowSource: wf.source, meta: { repo: '/r', worktree: '/w', branch: 'eos/t1', baseSha: '0'.repeat(40) } }, 1)
  const data: DataSource = { store, conventions, changes: () => ({ base: 'b', head: 'h', files: [], omitted: 0 }), now: () => 100 }
  const chats = new ChatStore(store.db)
  const redact = (s: string) => redactText(s, [SECRET])
  const opts = (executor: McpExecutor): ChatOptions => ({ chats, data, conventions, executor, dataDir: dir, redact, now: () => 100 })
  const save = (id: number, allowPermissions = false, note?: string) =>
    saveProposal({ store, chats, conventions, redact, id, actor: 'cli', allowPermissions, ...(note === undefined ? {} : { note }), now: () => 200 })
  const dump = () => JSON.stringify(store.db.prepare('SELECT * FROM conventions ORDER BY kind, name, version').all())
  return { dir, store, conventions, chats, data, redact, opts, save, dump }
}

const tool = `mcp__${MCP_NAME}__${PROPOSE_TOOL}`
const steps =
  (list: { tool: string; args: Record<string, unknown> }[]): McpScript =>
  ({ results }) =>
    results.length < list.length ? list[results.length]! : { reply: '提了' }
const standard = (p: ReturnType<typeof platform>) => p.store.convention('workflow', 'standard')!.content

/** 让假 agent 提一条提议，返回它的提议号。 */
const propose = async (p: ReturnType<typeof platform>, args: Record<string, unknown>): Promise<number> => {
  const r = await new Chats(p.opts(new McpExecutor(steps([{ tool, args }])))).start('提一条', 'cli')
  assert.ok(r.ok, JSON.stringify(r))
  return p.chats.proposals(r.chat.id).at(-1)!.id
}

test('every tool the agent has, run once, leaves the conventions table unchanged; only a human save writes it', async () => {
  const p = platform()
  const before = p.dump()
  const args: Record<string, Record<string, unknown>> = {
    list_conventions: { kind: 'workflow' },
    get_convention: { kind: 'workflow', name: 'standard' },
    convention_history: { kind: 'workflow', name: 'standard' },
    list_tasks: {},
    get_task: { id: 't1' },
    get_task_trace: { id: 't1' },
    get_task_metrics: { id: 't1' },
    get_task_changes: { id: 't1' },
    [PROPOSE_TOOL]: { kind: 'workflow', name: 'standard', content: standard(p).replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' },
  }
  const ex = new McpExecutor(steps(Object.entries(args).map(([name, a]) => ({ tool: `mcp__${MCP_NAME}__${name}`, args: a }))))
  const r = await new Chats(p.opts(ex)).start('把所有工具都用一遍', 'cli')
  assert.ok(r.ok)
  assert.deepEqual(ex.offered[0]!.map(t => t.replace(`mcp__${MCP_NAME}__`, '')).sort(), [...TOOLS.map(t => t.name), PROPOSE_TOOL].sort(), 'that is every tool the agent is offered')
  assert.equal(r.call.reads.filter(x => x.isError).length, 0, JSON.stringify(r.call.reads))
  assert.equal(p.dump(), before, 'nothing the agent ran wrote a convention')
  const saved = p.save(p.chats.proposals(r.chat.id)[0]!.id)
  assert.ok(saved.ok, JSON.stringify(saved))
  assert.notEqual(p.dump(), before)
})

test('saving records the operator and the source (chat and proposal) on the new version, and marks the proposal saved', async () => {
  const p = platform()
  const id = await propose(p, { kind: 'workflow', name: 'standard', content: standard(p).replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' })
  const prop = p.chats.proposal(id)!
  assert.deepEqual(prop.permissions, [], 'a description change touches no permission')
  const r = p.save(id, false, '看过了')
  assert.ok(r.ok, JSON.stringify(r))
  const row = p.store.convention('workflow', 'standard')!
  assert.equal(row.version, 2)
  assert.equal(row.actor, 'cli')
  assert.equal(row.note, `来自对话 ${prop.chatId} 的提议 #${id}：看过了`)
  assert.equal(row.content, prop.content)
  assert.deepEqual(p.chats.proposal(id)!.saved, { version: 2, actor: 'cli', at: 200 })
  const again = p.save(id)
  assert.equal(again.ok, false)
  assert.match((again as { error: string }).error, /已经保存过/)
})

test('a proposal that changes permissions is refused without the explicit confirmation, and saved with it', async () => {
  const p = platform()
  const before = p.dump()
  const id = await propose(p, { kind: 'workflow', name: 'standard', content: standard(p).replaceAll('timeoutSec: 600', 'timeoutSec: 60'), rationale: '缩短超时' })
  const refused = p.save(id)
  assert.equal(refused.ok, false)
  assert.match((refused as { error: string }).error, /涉及权限改动，要确认之后才能保存（命令行加 --allow-permissions）/)
  assert.ok((refused as { permissions?: string[] }).permissions?.includes('改了检查命令和平台动作'))
  assert.equal(p.dump(), before, 'nothing saved without the confirmation')
  const ok = p.save(id, true)
  assert.ok(ok.ok)
  assert.match(p.store.convention('workflow', 'standard')!.note, /（确认了权限改动）/)
  // 新建的约定总要确认（整份权限都要人看）。
  const fresh = await propose(p, { kind: 'workflow', name: 'standard-lite', content: standard(p).replace(/^name: .*$/m, 'name: standard-lite'), rationale: '新工作流' })
  assert.equal(p.save(fresh).ok, false)
  assert.ok(p.save(fresh, true).ok)
  assert.equal(p.store.convention('workflow', 'standard-lite')!.version, 1)
})

test('a proposal is checked again at save time: stale base version, a name taken meanwhile, voided, failing validation now, a credential value, or identical content are all refused', async () => {
  const p = platform()
  const cur = standard(p)
  const id = await propose(p, { kind: 'workflow', name: 'standard', content: cur.replace(/^description: .*$/m, 'description: A'), rationale: 'A' })
  // 别人先保存了一版：基于的版本过期。
  p.conventions.save({ kind: 'workflow', name: 'standard', content: cur.replace(/^description: .*$/m, 'description: B'), actor: 'web' }, 150)
  const before = p.dump()
  const stale = p.save(id, true)
  assert.equal(stale.ok, false)
  assert.match((stale as { error: string }).error, /基于第 1 版，「standard」现在是第 2 版/)
  assert.equal(p.dump(), before)
  // 新建的名字已经被人建了。
  const fresh = await propose(p, { kind: 'workflow', name: 'lite', content: cur.replace(/^name: .*$/m, 'name: lite'), rationale: '新' })
  p.conventions.save({ kind: 'workflow', name: 'lite', content: cur.replace(/^name: .*$/m, 'name: lite').replace(/^description: .*$/m, 'description: 抢先'), actor: 'web' }, 160)
  assert.match((p.save(fresh, true) as { error: string }).error, /已经有它的第 1 版了/)
  // 直接写进提议表的几种（模拟记下之后平台状态变了）：
  const chatId = p.chats.proposal(id)!.chatId
  const add = (content: string, extra: Partial<{ voided: string }> = {}) => {
    const row = p.chats.addProposal({ chatId, call: 'c', kind: 'workflow', name: 'standard', baseVersion: 2, content, rationale: 'x', permissions: [] }, 1)
    if (extra.voided !== undefined) p.chats.voidProposals('c', extra.voided)
    return row.id
  }
  const v2 = p.store.convention('workflow', 'standard')!.content
  assert.match((p.save(add(v2.replace(/role: (\w+)/, 'role: gone'))) as { error: string }).error, /按现在的平台状态没有通过检查/)
  assert.match((p.save(add(`${v2}\n# ${SECRET}\n`)) as { error: string }).error, /凭据值/)
  assert.match((p.save(add(v2)) as { error: string }).error, /已经和这条提议一样/)
  assert.match((p.save(add(v2.replace(/^description: .*$/m, 'description: C'), { voided: '作废了' })) as { error: string }).error, /已作废/)
  assert.match((p.save(9999) as { error: string }).error, /没有提议 #9999/)
})

test('permissions are recomputed from the current state at save time, not trusted from the stored list', async () => {
  const p = platform()
  const v1 = standard(p)
  const id = await propose(p, { kind: 'workflow', name: 'standard', content: v1.replace(/^description: .*$/m, 'description: A'), rationale: 'A' })
  // 记下时没有权限改动；把存下的内容改成会改检查命令的（模拟算好的列表已经不准）。
  p.store.db.prepare('UPDATE chat_proposals SET content = ? WHERE id = ?').run(v1.replaceAll('timeoutSec: 600', 'timeoutSec: 5'), id)
  assert.deepEqual(p.chats.proposal(id)!.permissions, [])
  const r = p.save(id)
  assert.equal(r.ok, false)
  assert.ok((r as { permissions?: string[] }).permissions?.includes('改了检查命令和平台动作'))
})

test('two saves based on the same version: only one wins (the version check and the write are one transaction)', () => {
  const p = platform()
  const base = { kind: 'workflow' as const, name: 'standard', note: 'n', actor: 'cli' }
  const first = p.store.saveConventionIfLatest({ ...base, content: standard(p).replace(/^description: .*$/m, 'description: X') }, 1, 1)
  const second = p.store.saveConventionIfLatest({ ...base, content: standard(p).replace(/^description: .*$/m, 'description: Y') }, 1, 2)
  assert.ok('version' in first && first.version === 2)
  assert.deepEqual(second, { stale: true, latest: 2 })
  const created = p.store.saveConventionIfLatest({ ...base, name: 'brand-new', content: 'x' }, undefined, 3)
  assert.ok('version' in created && created.version === 1, 'a new name saves when nothing exists yet')
})

test('eos chat show prints each proposal with its state, the diff against the current version (full text when new), the permission warning, and how to save', async () => {
  const p = platform()
  const changed = await propose(p, { kind: 'workflow', name: 'standard', content: standard(p).replaceAll('timeoutSec: 600', 'timeoutSec: 60'), rationale: '缩短超时' })
  const chatId = p.chats.proposal(changed)!.chatId
  const out: string[] = []
  const run = (args: string[], extra: { allowPermissions?: boolean } = {}) =>
    chatCommand(args, {
      chats: p.chats,
      data: p.data,
      conventions: p.conventions,
      dataDir: p.dir,
      redact: p.redact,
      now: () => 300,
      executor: () => new McpExecutor(() => ({ reply: 'x' })),
      say: s => void out.push(s),
      fail: s => {
        throw new Error(s)
      },
      ...extra,
    })
  await run(['show', chatId])
  const text = out.join('\n')
  assert.match(text, /#\d+ {2}工作流「standard」（修改，基于第 1 版）/)
  assert.match(text, /状态：待确认，还没有保存/)
  assert.match(text, /⚠⚠ 涉及权限改动，保存时必须加 --allow-permissions/)
  assert.match(text, /- .*timeoutSec: 600/)
  assert.match(text, /\+ .*timeoutSec: 60\b/)
  assert.match(text, /… 省略 \d+ 行/)
  assert.match(text, new RegExp(`chat save ${changed} --allow-permissions`))
  await assert.rejects(run(['save', String(changed)]), /--allow-permissions/)
  out.length = 0
  await run(['save', String(changed)], { allowPermissions: true })
  assert.match(out.join('\n'), /已保存：工作流「standard」第 2 版（来自对话 .* 的提议 #\d+，确认了权限改动）/)
  out.length = 0
  await run(['show', chatId])
  assert.match(out.join('\n'), /状态：已保存为第 2 版（cli，/)
  // 新建的：显示全文。
  const fresh = await propose(p, { kind: 'template', name: 'helper', content: p.store.convention('template', 'reviewer')!.content.replace(/^name: .*$/m, 'name: helper'), rationale: '新角色' })
  out.length = 0
  await run(['show', p.chats.proposal(fresh)!.chatId])
  assert.match(out.join('\n'), /全文（新建）：\n {8}\+ name: helper/)
})

test('the modules the agent can trigger never import the save path', () => {
  for (const f of ['chat.ts', 'mcp.ts', 'tools.ts', 'proposals.ts', 'store.ts']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'chat', f), 'utf8')
    assert.ok(!/(from|import\()\s*['"]\.\/save(\.ts)?['"]/.test(src), `src/chat/${f} imports the save path`)
  }
})
