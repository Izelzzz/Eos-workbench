import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Chats, MCP_NAME, type ChatOptions } from '../src/chat/chat.ts'
import { MAX_PROPOSALS_PER_CALL, PROPOSE_TOOL } from '../src/chat/proposals.ts'
import { ChatStore } from '../src/chat/store.ts'
import type { DataSource } from '../src/chat/tools.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { redactText } from '../src/credentials/redact.ts'
import { Store } from '../src/store/store.ts'
import { McpExecutor, type McpScript } from './mcp-executor.ts'

// 运行时拼出来：源码里不出现像 key 的整串字面量（gitleaks）。
const SECRET = ['sk', 'propose', 'test', '0123456789', 'secret'].join('-')
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const platform = () => {
  const dir = mkdtempSync(join(tmpdir(), 'eos-propose-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'eos.db'))
  const conventions = new Conventions(store)
  conventions.seed(1)
  const data: DataSource = { store, conventions, changes: () => ({ base: 'b', head: 'h', files: [], omitted: 0 }), now: () => 100 }
  const chats = new ChatStore(store.db)
  const opts = (executor: McpExecutor): ChatOptions => ({ chats, data, conventions, executor, dataDir: dir, redact: s => redactText(s, [SECRET]), now: () => 100 })
  /** 约定表的全部内容：用来证明 agent 的任何操作都没有保存约定。 */
  const conventionsDump = () => JSON.stringify(store.db.prepare('SELECT * FROM conventions ORDER BY kind, name, version').all())
  return { store, conventions, chats, opts, conventionsDump }
}

const tool = `mcp__${MCP_NAME}__${PROPOSE_TOOL}`
const standard = (p: ReturnType<typeof platform>) => p.store.convention('workflow', 'standard')!.content
const renamed = (yaml: string, name: string) => yaml.replace(/^name: .*$/m, `name: ${name}`)

/** 剧本：按顺序调这些工具，最后把每一步的结果拼进回复。 */
const steps =
  (list: { tool: string; args: Record<string, unknown> }[]): McpScript =>
  ({ results }) =>
    results.length < list.length ? list[results.length]! : { reply: results.join('\n---\n') }

test('a valid proposal is recorded as pending and changes no convention; the agent never gets a tool that saves', async () => {
  const p = platform()
  const before = p.conventionsDump()
  const yaml = renamed(standard(p), 'standard-lite')
  const ex = new McpExecutor(steps([{ tool, args: { kind: 'workflow', name: 'standard-lite', content: yaml, rationale: '少一个阶段' } }]))
  const r = await new Chats(p.opts(ex)).start('帮我设计一个更轻的工作流', 'cli')
  assert.ok(r.ok, JSON.stringify(r))
  assert.match(r.reply, /提议 #1 已记下：新建工作流「standard-lite」.*还没有生效/)
  const [row] = p.chats.proposals(r.chat.id)
  assert.equal(row!.content, yaml)
  assert.equal(row!.baseVersion, undefined)
  assert.equal(row!.call, `chat/${r.chat.id}/1`)
  assert.equal(p.conventionsDump(), before, 'the proposal saved nothing')
  // 交给 agent 的工具：只读工具和提议工具，没有任何保存、批准的工具。
  const offered = ex.offered[0]!.map(t => t.replace(`mcp__${MCP_NAME}__`, ''))
  assert.ok(offered.includes(PROPOSE_TOOL))
  assert.ok(!offered.some(t => /save|approve|apply|write|update|delete|decide/.test(t)), offered.join(','))
})

test('a proposal that fails the save validation goes back to the agent with the errors; the fixed one is recorded', async () => {
  const p = platform()
  const good = renamed(standard(p), 'standard-lite')
  const ex = new McpExecutor(
    steps([
      { tool, args: { kind: 'workflow', name: 'standard-lite', content: good.replace(/role: (\w+)/, 'role: no-such-role'), rationale: '第一次' } },
      { tool, args: { kind: 'workflow', name: 'other-name', content: good, rationale: '名字对不上' } },
      { tool, args: { kind: 'workflow', name: 'standard-lite', content: good, rationale: '改好了' } },
    ]),
  )
  const r = await new Chats(p.opts(ex)).start('设计一个工作流', 'cli')
  assert.ok(r.ok)
  assert.equal(r.call.reads.filter(x => x.isError).length, 2)
  assert.match(r.reply, /没有通过检查，改了再提/)
  assert.match(r.reply, /和要保存的「other-name」不一致/)
  assert.deepEqual(
    p.chats.proposals(r.chat.id).map(x => x.rationale),
    ['改好了'],
  )
})

test('a change to an existing workflow records the base version; an unchanged copy, a credential value, and more than the per-call cap are refused', async () => {
  const p = platform()
  const cur = standard(p)
  const changed = cur.replace(/^description: .*$/m, 'description: 改过的说明')
  const many = Array.from({ length: MAX_PROPOSALS_PER_CALL + 1 }, (_, i) => ({ tool, args: { kind: 'workflow', name: `wf-${i}`, content: renamed(cur, `wf-${i}`), rationale: '批量' } }))
  const ex = new McpExecutor(
    steps([
      { tool, args: { kind: 'workflow', name: 'standard', content: changed, rationale: '改说明' } },
      { tool, args: { kind: 'workflow', name: 'standard', content: cur, rationale: '没改' } },
      { tool, args: { kind: 'workflow', name: 'standard', content: `${changed}\n# ${SECRET}\n`, rationale: '带了 key' } },
      ...many,
    ]),
  )
  const r = await new Chats(p.opts(ex)).start('改一下 standard', 'cli')
  assert.ok(r.ok)
  const rows = p.chats.proposals(r.chat.id)
  assert.equal(rows[0]!.baseVersion, 1)
  assert.match(r.reply, /完全一样，不需要提议/)
  assert.match(r.reply, /提议里有凭据值/)
  assert.match(r.reply, new RegExp(`已经记了 ${MAX_PROPOSALS_PER_CALL} 条提议`))
  assert.equal(rows.length, MAX_PROPOSALS_PER_CALL, 'the cap counts every recorded proposal in the call')
  assert.ok(!JSON.stringify(rows).includes(SECRET))
})

test('Agent templates can be proposed too, and are checked like a save (skills must exist)', async () => {
  const p = platform()
  const reviewer = p.store.convention('template', 'reviewer')!.content
  const strict = reviewer.replace(/^name: .*$/m, 'name: strict-reviewer')
  const ex = new McpExecutor(
    steps([
      { tool, args: { kind: 'template', name: 'strict-reviewer', content: `${strict}\nskills: [no-such-skill]\n`, rationale: '要个技能' } },
      { tool, args: { kind: 'template', name: 'strict-reviewer', content: strict, rationale: '更严的评审' } },
    ]),
  )
  const r = await new Chats(p.opts(ex)).start('要一个更严的评审角色', 'cli')
  assert.ok(r.ok)
  assert.match(r.reply, /skills\[0\]：平台上没有名为「no-such-skill」的技能/)
  assert.deepEqual(
    p.chats.proposals(r.chat.id).map(x => [x.kind, x.name]),
    [['template', 'strict-reviewer']],
  )
})

test('proposals from a turn that is voided (a non-platform tool ran) are voided too', async () => {
  const p = platform()
  const ex = new McpExecutor(
    steps([
      { tool, args: { kind: 'workflow', name: 'standard-lite', content: renamed(standard(p), 'standard-lite'), rationale: 'x' } },
      { tool: 'write', args: { path: '/tmp/x' } },
    ]),
  )
  const r = await new Chats(p.opts(ex)).start('设计一个工作流', 'cli')
  assert.equal(r.ok, false)
  const [row] = p.chats.proposals(r.chat!.id)
  assert.match(row!.voided ?? '', /这一轮作废/)
})

test('no code the agent can reach saves a convention: the chat modules never call a convention write', () => {
  // agent 能触发的代码：端点、工具、提议、对话流程。它们都不调用保存约定的方法（保存只在人确认的路径里）。
  for (const f of ['chat.ts', 'mcp.ts', 'tools.ts', 'proposals.ts', 'store.ts']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'chat', f), 'utf8')
    for (const write of [
      'saveConvention',
      'seedConvention',
      'insertConvention',
      'decideProposal',
      'conventions.save(',
      'conventions.seed(',
      '.save({',
      'INSERT INTO conventions',
      'UPDATE conventions',
    ])
      assert.ok(!src.includes(write), `src/chat/${f} contains ${write}`)
  }
})

test('proposals from a turn that got no reply (the call failed, or could not be claimed after a restart) are voided', async () => {
  const p = platform()
  const yaml = renamed(standard(p), 'standard-lite')
  // 调用失败：执行器在提议之后抛错。
  const failing = new McpExecutor(steps([{ tool, args: { kind: 'workflow', name: 'standard-lite', content: yaml, rationale: 'x' } }]))
  const send = failing.send.bind(failing)
  failing.send = async q => {
    await send(q)
    throw new Error('连接断了')
  }
  const r = await new Chats(p.opts(failing)).start('设计一个工作流', 'cli')
  assert.equal(r.ok, false)
  assert.match(p.chats.proposals(r.chat!.id)[0]!.voided ?? '', /调用失败：连接断了/)
  // 平台重启：这一句的提议已经记下，但调用没做完、也认领不到回复。
  const id = p.chats.create({ id: 'c7', firstMessage: '你好', actor: 'cli' }, 1).id
  const seq = p.chats.append(id, { at: 1, role: 'user', text: '设计一个工作流', actor: 'cli' })
  p.chats.addProposal({ chatId: id, call: `chat/${id}/${seq}`, kind: 'workflow', name: 'standard-lite', content: yaml, rationale: 'x', permissions: [] }, 1)
  assert.ok((await new Chats(p.opts(new McpExecutor(() => ({ reply: '好' })))).send(id, '还在吗', 'cli')).ok)
  assert.match(p.chats.proposals(id)[0]!.voided ?? '', /没有得到回复/)
})

test('the permission changes of a proposal are computed when it is recorded (the improvement-proposal guard, plus template skills), and told to the agent', async () => {
  const p = platform()
  const wf = standard(p)
  const dev = p.store.convention('template', 'developer')!.content
  const ex = new McpExecutor(
    steps([
      // 改检查命令：改进提案的核对会拦的那一类。
      { tool, args: { kind: 'workflow', name: 'standard', content: wf.replaceAll('timeoutSec: 600', 'timeoutSec: 60'), rationale: '缩短超时' } },
      // 只改说明：不涉及权限。
      { tool, args: { kind: 'workflow', name: 'standard', content: wf.replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' } },
      // 模板：放宽写入范围、去掉技能。
      { tool, args: { kind: 'template', name: 'developer', content: dev.replace(/^writePaths: .*$/m, 'writePaths: ["**"]').replace(/^skills: .*$/m, 'skills: []'), rationale: '放开' } },
      // 新建的模板和工作流：整份权限都要看。
      { tool, args: { kind: 'template', name: 'helper', content: dev.replace(/^name: .*$/m, 'name: helper'), rationale: '新角色' } },
      { tool, args: { kind: 'workflow', name: 'standard-lite', content: renamed(wf, 'standard-lite'), rationale: '新工作流' } },
    ]),
  )
  const r = await new Chats(p.opts(ex)).start('改一下', 'cli')
  assert.ok(r.ok)
  const [checks, desc, tpl, newTpl, newWf] = p.chats.proposals(r.chat.id).map(x => x.permissions)
  assert.ok(checks!.includes('不能改检查命令和平台动作'), JSON.stringify(checks))
  assert.deepEqual(desc, [])
  assert.ok(tpl!.includes('不能改模板的 writePaths'), JSON.stringify(tpl))
  assert.ok(
    tpl!.some(x => x.startsWith('模板的技能从 write-changes 改成 无')),
    JSON.stringify(tpl),
  )
  assert.match(newTpl![0]!, /^新建的 Agent 模板：模型 .*写入 worktree（src\/\*\*/)
  assert.match(newWf![0]!, /^新建的工作流/)
  assert.match(r.reply, /这条提议涉及权限，用户确认时会单独看到/)
})
