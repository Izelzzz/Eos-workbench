import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { MCP_NAME } from '../src/chat/chat.ts'
import { PROPOSE_TOOL } from '../src/chat/proposals.ts'
import { saveProposal } from '../src/chat/save.ts'
import { ChatStore } from '../src/chat/store.ts'
import { redactText } from '../src/credentials/redact.ts'
import { Credentials } from '../src/credentials/store.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { WebChats } from '../src/web/chat.ts'
import { createWebServer } from '../src/web/server.ts'
import type { ChatStreamLine, ChatView, SaveChatProposalResponse } from '../src/web/types.ts'
import { FakeExecutor } from './fake-executor.ts'
import { McpExecutor, type McpScript } from './mcp-executor.ts'

// 运行时拼出来：源码里不出现像 key 的整串字面量（gitleaks）。
const SECRET = ['sk', 'webchat', 'test', '0123456789', 'secret'].join('-')
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const propose = `mcp__${MCP_NAME}__${PROPOSE_TOOL}`

/** 起一个带对话的网页服务。make 给出假 agent 的剧本（std 读平台上现在的 standard 工作流）。 */
const serve = async (make: (std: () => string) => McpScript, withChat = true) => {
  const dir = mkdtempSync(join(tmpdir(), 'eos-web-chat-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'static'))
  writeFileSync(join(dir, 'static', 'index.html'), '<html>eos</html>')
  const store = new Store(join(dir, 'eos.db'))
  const supervisor = new Supervisor({ store, executor: new FakeExecutor(async () => 'x'), dataDir: dir, pollMs: 5 })
  const credentials = new Credentials(join(dir, 'eos.db'), undefined)
  const redact = (s: string) => redactText(s, [SECRET])
  const chat = new WebChats({
    store,
    conventions: supervisor.conventions,
    executor: new McpExecutor(make(() => store.convention('workflow', 'standard')!.content)),
    dataDir: dir,
    redact,
    changes: () => ({ base: 'b', head: 'h', files: [], omitted: 0 }),
    now: Date.now,
  })
  const server = createWebServer({ store, supervisor, replay: { traceOf: async () => [] }, staticDir: join(dir, 'static'), credentials, ...(withChat ? { chat } : {}) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) })
  /** 发一句话，收齐推送的每一行。 */
  const say = async (body: Record<string, unknown>): Promise<ChatStreamLine[]> => {
    const res = await post('/api/chats', body)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/)
    return (await res.text())
      .split('\n')
      .filter(l => l !== '')
      .map(l => JSON.parse(l) as ChatStreamLine)
  }
  const view = async (id: string) => (await (await fetch(`${base}/api/chats/${id}`)).json()) as ChatView
  const save = async (id: number, body: Record<string, unknown> = {}) => (await (await post(`/api/chats/proposals/${id}/save`, body)).json()) as SaveChatProposalResponse
  const standard = () => store.convention('workflow', 'standard')!.content
  return {
    dir,
    store,
    conventions: supervisor.conventions,
    chat,
    base,
    post,
    say,
    view,
    save,
    standard,
    close: () => new Promise(r => server.close(() => (credentials.close(), r(undefined)))),
  }
}

/** 先读一次 standard，再按 args 提议，最后回复。 */
const reading = (args: () => Record<string, unknown>): McpScript => {
  let proposed = false
  return ({ results }) => {
    if (results.length === 0) return { tool: `mcp__${MCP_NAME}__get_convention`, args: { kind: 'workflow', name: 'standard' } }
    if (!proposed) {
      proposed = true
      return { tool: propose, args: args() }
    }
    return { reply: '提了一条，等你确认' }
  }
}

test('a new chat streams what the agent reads and writes, then the result; the chat is listed and its reads are recorded', async () => {
  const s = await serve(std => reading(() => ({ kind: 'workflow', name: 'standard', content: std().replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' })))
  try {
    const lines = await s.say({ text: '把 standard 的说明改一下' })
    assert.deepEqual(
      lines.map(l => l.type),
      ['read', 'read', 'text', 'done'],
    )
    assert.deepEqual(lines[0], { type: 'read', id: 't1', tool: 'get_convention', args: JSON.stringify({ kind: 'workflow', name: 'standard' }) }, 'the MCP prefix is not shown')
    const second = lines[1]!
    assert.equal(second.type === 'read' ? second.tool : undefined, PROPOSE_TOOL)
    assert.deepEqual(lines[2], { type: 'text', text: '提了一条，等你确认' })
    const done = lines[3] as Extract<ChatStreamLine, { type: 'done' }>
    assert.ok(done.ok)
    const list = (await (await fetch(`${s.base}/api/chats`)).json()) as { id: string; actor: string }[]
    assert.deepEqual(
      list.map(c => [c.id, c.actor]),
      [[done.chat, 'web']],
    )
    const v = await s.view(done.chat)
    assert.deepEqual(
      v.log.map(m => m.role),
      ['user', 'assistant'],
    )
    const reply = v.log[1]!
    assert.ok(reply.role === 'assistant')
    assert.deepEqual(
      reply.call.reads.map(r => r.tool),
      ['get_convention', PROPOSE_TOOL],
    )
    assert.equal(v.metrics.reads, 1)
    // 接着说：同一个对话。
    const next = await s.say({ chat: done.chat, text: '再看看' })
    assert.deepEqual(next.at(-1), { type: 'done', ok: true, chat: done.chat })
    assert.equal((await s.view(done.chat)).log.length, 4)
  } finally {
    await s.close()
  }
})

test('a proposal is shown with its state, the current version and the permission code; saving needs that code and records the operator as web', async () => {
  const s = await serve(std => reading(() => ({ kind: 'workflow', name: 'standard', content: std().replaceAll('timeoutSec: 600', 'timeoutSec: 60'), rationale: '缩短超时' })))
  try {
    const done = (await s.say({ text: '缩短检查超时' })).at(-1) as Extract<ChatStreamLine, { type: 'done'; ok: true }>
    const v = await s.view(done.chat)
    assert.equal(v.proposals.length, 1)
    const p = v.proposals[0]!
    assert.equal(p.state, 'pending')
    assert.equal(p.current?.version, 1)
    assert.equal(p.current?.content, s.standard())
    assert.ok(p.permissions.includes('改了检查命令和平台动作'))
    assert.match(p.code ?? '', /^[0-9a-f]{8}$/)
    const before = s.store.conventionHistory('workflow', 'standard').length
    // 不带确认码、带错的确认码：都拒绝，约定不变。
    for (const body of [{}, { confirm: '00000000' }]) {
      const r = await s.save(p.proposal.id, body)
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.code, p.code)
      assert.equal(s.store.conventionHistory('workflow', 'standard').length, before)
    }
    const r = await s.save(p.proposal.id, { confirm: p.code, note: '网页确认' })
    assert.deepEqual(r, { ok: true, version: 2, permissions: p.permissions })
    const row = s.store.convention('workflow', 'standard')!
    assert.equal(row.actor, 'web')
    assert.match(row.note, new RegExp(`^来自对话 ${done.chat} 的提议 #${p.proposal.id}（确认了权限改动：.*）：网页确认$`))
    const after = (await s.view(done.chat)).proposals[0]!
    assert.equal(after.state, 'saved')
    assert.equal(after.proposal.saved?.actor, 'web')
    assert.equal(after.code, undefined)
    assert.equal((await s.save(p.proposal.id, { confirm: p.code })).ok, false, 'saved only once')
  } finally {
    await s.close()
  }
})

test('the web save writes the convention and the proposal mark through the store’s own connection (a ChatStore on another connection cannot)', async () => {
  const s = await serve(std => reading(() => ({ kind: 'workflow', name: 'standard', content: std().replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' })))
  try {
    const done = (await s.say({ text: '改说明' })).at(-1) as Extract<ChatStreamLine, { type: 'done'; ok: true }>
    const id = (await s.view(done.chat)).proposals[0]!.proposal.id
    // 同一个连接：在 store.db 开的写事务里，网页服务的 ChatStore 能写，store.db 读得到这笔还没提交的写入；回滚之后就没了。
    s.store.db.exec('BEGIN IMMEDIATE')
    const salt = s.chat.chats.confirmSalt(id)
    const seen = s.store.db.prepare('SELECT confirm_salt FROM chat_proposals WHERE id = ?').get(id) as { confirm_salt: string | null }
    s.store.db.exec('ROLLBACK')
    assert.equal(seen.confirm_salt, salt)
    assert.equal((s.store.db.prepare('SELECT confirm_salt FROM chat_proposals WHERE id = ?').get(id) as { confirm_salt: string | null }).confirm_salt, null)
    // 对照：提议表换一个连接，保存在事务里碰到库被锁，整笔回滚。这就是 WebChats 自己从 store.db 建 ChatStore 的原因。
    const other = new ChatStore(new DatabaseSync(join(s.dir, 'eos.db')))
    assert.throws(() => saveProposal({ store: s.store, chats: other, conventions: s.conventions, redact: x => x, id, actor: 'web', now: Date.now }))
    assert.equal(s.store.conventionHistory('workflow', 'standard').length, 1)
    assert.equal(s.chat.chats.proposal(id)!.saved, undefined)
    const r = await s.save(id)
    assert.deepEqual(r, { ok: true, version: 2, permissions: [] })
    assert.equal(s.chat.chats.proposal(id)!.saved?.version, 2)
  } finally {
    await s.close()
  }
})

test('while the turn has no reply yet, the proposal shows as unanswered with no code, and saving it is refused', async () => {
  let during: { view: ChatView; save: SaveChatProposalResponse } | undefined
  let proposed = false
  const s = await serve(std => () => {
    if (!proposed) {
      proposed = true
      return { tool: propose, args: { kind: 'workflow', name: 'standard', content: std().replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' } }
    }
    return { reply: '好了' }
  })
  try {
    // 这一轮进行中（提议已经落库、回复还没写）：从另一个请求看。
    const chats = s.chat.chats
    const original = chats.append.bind(chats)
    chats.append = (id, m) => {
      if (m.role === 'assistant' && during === undefined) {
        const pid = chats.proposals(id)[0]!.id
        during = { view: { ...s.chat.detail(id)! }, save: s.chat.save(pid, {}) as SaveChatProposalResponse }
      }
      return original(id, m)
    }
    await s.say({ text: '改说明' })
    assert.equal(during?.view.proposals[0]?.state, 'unanswered')
    assert.equal(during?.view.proposals[0]?.code, undefined)
    assert.equal(during?.save.ok, false)
    assert.match((during!.save as { error: string }).error, /那一轮还没有回复/)
  } finally {
    await s.close()
  }
})

test('the whole chat view is redacted: messages, title and proposals recorded before the platform held that credential', async () => {
  const s = await serve(std => reading(() => ({ kind: 'workflow', name: 'standard', content: std().replace(/^description: .*$/m, 'description: 新说明'), rationale: '改说明' })))
  try {
    const done = (await s.say({ text: '改说明' })).at(-1) as Extract<ChatStreamLine, { type: 'done'; ok: true }>
    const id = (await s.view(done.chat)).proposals[0]!.proposal.id
    // 模拟：提议记下之后，平台才有了一个和其中一段相同的凭据值。
    s.store.db.prepare('UPDATE chat_proposals SET content = content || ? WHERE id = ?').run(`\n# ${SECRET}\n`, id)
    // 用户把 key 贴进了对话（标题取自第一句话），平台之后才把它存成凭据。
    s.store.db.prepare("UPDATE chat_messages SET text = text || ? WHERE chat_id = ? AND role = 'user'").run(` ${SECRET}`, done.chat)
    s.store.db.prepare('UPDATE chats SET title = title || ? WHERE id = ?').run(` ${SECRET}`, done.chat)
    const text = JSON.stringify(await s.view(done.chat))
    assert.ok(!text.includes(SECRET))
    assert.equal((await s.save(id)).ok, false, 'and it cannot be saved')
  } finally {
    await s.close()
  }
})

test('chat writes need a same-origin JSON request; without a chat agent the endpoints answer 503', async () => {
  const s = await serve(() => () => ({ reply: 'x' }))
  try {
    const evil = await s.post('/api/chats', { text: '你好' }, 'https://evil.example')
    assert.equal(evil.status, 403)
    assert.equal((await s.post('/api/chats/proposals/1/save', {}, 'https://evil.example')).status, 403)
    assert.deepEqual(await (await fetch(`${s.base}/api/chats`)).json(), [], 'nothing was created')
    const bad = await s.say({ text: 42 })
    assert.deepEqual(bad, [{ type: 'done', ok: false, error: '需要 text（要说的话）' }])
    assert.equal((await fetch(`${s.base}/api/chats/cnope`)).status, 404)
  } finally {
    await s.close()
  }
  const none = await serve(() => () => ({ reply: 'x' }), false)
  try {
    assert.equal((await fetch(`${none.base}/api/chats`)).status, 503)
    assert.equal((await none.post('/api/chats', { text: '你好' })).status, 503)
  } finally {
    await none.close()
  }
})

test('a turn that throws ends the stream with an error line, and the server keeps serving', async () => {
  const s = await serve(() => () => ({ reply: 'x' }))
  try {
    s.chat.chats.append = () => {
      throw new Error(`库被锁了 ${SECRET}`)
    }
    const lines = await s.say({ text: '你好' })
    const last = lines.at(-1) as Extract<ChatStreamLine, { type: 'done' }>
    assert.equal(last.ok, false)
    assert.match(!last.ok ? last.error : '', /这一轮出错了：库被锁了/)
    assert.ok(!JSON.stringify(lines).includes(SECRET), 'the error is redacted')
    assert.equal((await fetch(`${s.base}/api/chats`)).status, 200, 'still serving')
  } finally {
    await s.close()
  }
})

test('a stale proposal still lists its permission changes, but has no code and cannot be saved', async () => {
  const s = await serve(std => reading(() => ({ kind: 'workflow', name: 'standard', content: std().replaceAll('timeoutSec: 600', 'timeoutSec: 60'), rationale: '缩短超时' })))
  try {
    const done = (await s.say({ text: '缩短检查超时' })).at(-1) as Extract<ChatStreamLine, { type: 'done'; ok: true }>
    s.conventions.save({ kind: 'workflow', name: 'standard', content: s.standard().replace(/^description: .*$/m, 'description: 别人改的'), actor: 'cli' }, Date.now())
    const v = (await s.view(done.chat)).proposals[0]!
    assert.equal(v.state, 'stale')
    assert.ok(v.permissions.includes('改了检查命令和平台动作'))
    assert.equal(v.code, undefined)
    assert.equal((await s.save(v.proposal.id, {})).ok, false)
  } finally {
    await s.close()
  }
})
