import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { acquire } from '../src/runner/lock.ts'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store/store.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import { createWebServer } from '../src/web/server.ts'
import type { TaskDetail } from '../src/web/types.ts'
import { CHANGES, PASS, workflow } from './helpers.ts'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const serve = async () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-web-'))
  mkdirSync(join(dir, 'static'))
  writeFileSync(join(dir, 'static', 'index.html'), '<html>eos</html>')
  writeFileSync(join(dir, 'secret.txt'), 'do not serve')
  mkdirSync(join(dir, 'static-evil'))
  writeFileSync(join(dir, 'static-evil', 'x.txt'), 'sibling secret')
  const store = new Store(join(dir, 'eos.db'))
  store.create({ id: 't1', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: { repo: '/r', worktree: '/w', branch: 'eos/t1', baseSha: 'abc' } }, 1000)
  const replayed: string[] = []
  // c1 跑在事件流之前（只能回放），c2 运行时记录了事件流。
  store.dispatch('t1', { kind: 'replied', call: 'c1' as never, sessionId: 's', text: '方案', usage: zero, ms: 100 }, 1100, 'executor')
  store.appendTrace('t1', 'c2', [{ kind: 'call_start', t: 1200 }, { kind: 'step_start', t: 1201, step: 1 }])
  const replay = { traceOf: async (key: string, nonce: string): Promise<TraceEvent[]> => { replayed.push(`${key} ${nonce}`); return [{ kind: 'call_start', t: 1000 }, { kind: 'step_start', t: 1001, step: 1 }, { kind: 'step_end', t: 1090, step: 1 }] } }
  const locksDir = join(dir, 'locks')
  const server = createWebServer({ store, replay, staticDir: join(dir, 'static'), locksDir })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, store, replayed, locksDir, close: () => new Promise(r => server.close(r)) }
}

test('lists tasks and returns a detail with the trace tree, replaying calls recorded before the trace existed', async () => {
  const s = await serve()
  try {
    const list = await (await fetch(`${s.base}/api/tasks`)).json()
    assert.deepEqual(list.map((t: { id: string }) => t.id), ['t1'])
    const d = (await (await fetch(`${s.base}/api/tasks/t1`)).json()) as TaskDetail
    assert.equal(d.status, 'running')
    assert.equal(d.branch, 'eos/t1')
    const [plan, build] = d.trace.children
    assert.equal(plan!.children[0]!.id, 'c1')
    assert.equal(plan!.children[0]!.children.length, 1, 'c1 step replayed from the session log')
    assert.equal(build!.children[0]!.status, 'running', 'c2 is in flight with its streamed step')
    assert.deepEqual(s.replayed, ['t1/plan t1/c1'], 'only the call without a stored trace is replayed')
    await fetch(`${s.base}/api/tasks/t1`)
    assert.equal(s.replayed.length, 1, 'replay of a finished call is cached')
  } finally {
    await s.close()
  }
})

test('unknown tasks are 404, non-GET is refused, and static paths cannot escape the build directory', async () => {
  const s = await serve()
  try {
    assert.equal((await fetch(`${s.base}/api/tasks/nope`)).status, 404)
    assert.equal((await fetch(`${s.base}/api/tasks`, { method: 'POST' })).status, 405)
    const escaped = await (await fetch(`${s.base}/..%2fsecret.txt`)).text()
    assert.doesNotMatch(escaped, /do not serve/)
    for (const path of ['/../static-evil/x.txt', '/%2e%2e/static-evil/x.txt', '/..%2fstatic-evil%2fx.txt']) {
      assert.doesNotMatch(await (await fetch(`${s.base}${path}`)).text(), /sibling secret/, path)
    }
    assert.match(await (await fetch(`${s.base}/tasks/anything`)).text(), /eos/, 'SPA fallback to index.html')
  } finally {
    await s.close()
  }
})

test('a finished task has no running spans', async () => {
  const s = await serve()
  try {
    s.store.dispatch('t1', { kind: 'replied', call: 'c2' as never, sessionId: 's', text: '实现', usage: zero, ms: 50 }, 1300, 'executor')
    s.store.appendTrace('t1', 'c2', [{ kind: 'step_end', t: 1290, step: 1 }])
    s.store.dispatch('t1', { kind: 'replied', call: 'c3' as never, sessionId: 's', text: PASS, usage: zero, ms: 10 }, 1400, 'executor')
    const d = (await (await fetch(`${s.base}/api/tasks/t1`)).json()) as TaskDetail
    assert.equal(d.status, 'done')
    const walk = (x: TaskDetail['trace']): string[] => [x.status, ...x.children.flatMap(walk)]
    assert.ok(!walk(d.trace).includes('running'))
  } finally {
    await s.close()
  }
})

const post = (base: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', origin: base }) =>
  fetch(`${base}/api/tasks/t1/answer`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('answering an agent question from the page records it as a web answer and the call goes on', async () => {
  const s = await serve()
  try {
    s.store.dispatch('t1', { kind: 'asked', call: 'c2' as never, question: { id: 'n', text: '红色还是绿色？', options: ['红色', '绿色'] } }, 1250, 'executor')
    const before = (await (await fetch(`${s.base}/api/tasks/t1`)).json()) as TaskDetail
    assert.equal(before.question?.id, 'q1')
    assert.equal(before.runnerAlive, false)
    const res = await post(s.base, { questionId: 'q1', text: '绿色' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, resumeNeeded: false })
    const task = s.store.get('t1')!
    assert.equal(task.status, 'running')
    assert.equal(task.pending?.id, 'c2', 'the in-flight call is still pending')
    assert.equal(s.store.events('t1').at(-1)?.actor, 'web')
    const again = await post(s.base, { questionId: 'q1', text: '红色' })
    assert.equal(again.status, 409)
    assert.equal((await again.json()).error, '没有待回答的这个问题')
  } finally {
    await s.close()
  }
})

test('cross-site, non-JSON, malformed and empty answers are refused without changing the task', async () => {
  const s = await serve()
  try {
    s.store.dispatch('t1', { kind: 'asked', call: 'c2' as never, question: { id: 'n', text: '?' } }, 1250, 'executor')
    const cases: [Promise<Response>, number, string][] = [
      [post(s.base, { questionId: 'q1', text: 'x' }, { 'content-type': 'application/json' }), 403, '只接受来自本页面的请求'],
      [post(s.base, { questionId: 'q1', text: 'x' }, { 'content-type': 'application/json', origin: 'https://evil.example' }), 403, '只接受来自本页面的请求'],
      [post(s.base, 'questionId=q1&text=x', { 'content-type': 'text/plain', origin: s.base }), 415, '请求体必须是 JSON'],
      [post(s.base, { questionId: 'q1' }), 400, '需要 questionId 和 text'],
      [post(s.base, { questionId: 'q9', text: 'x' }), 409, '没有待回答的这个问题'],
      [post(s.base, { questionId: 'q1', text: '   ' }), 409, '回答不能为空'],
    ]
    for (const [res, status, error] of cases) {
      const r = await res
      assert.equal(r.status, status, error)
      assert.equal((await r.json()).error, error)
    }
    assert.equal(s.store.get('t1')!.status, 'waiting_user')
    const big = await post(s.base, { questionId: 'q1', text: 'x'.repeat(70 * 1024) })
    assert.equal(big.status, 413)
    assert.equal((await big.json()).error, '请求体太大')
  } finally {
    await s.close()
  }
})

test('after answering a loop question, the page is told to resume only when no runner holds the task', async () => {
  for (const runner of [false, true]) {
    const s = await serve()
    try {
      // 走到对话尽头：c2 开发完成，c3 评审要求修改，maxRounds 1 且没有上游 → 问用户
      s.store.dispatch('t1', { kind: 'replied', call: 'c2' as never, sessionId: 's', text: '实现', usage: zero, ms: 1 }, 1300, 'executor')
      s.store.dispatch('t1', { kind: 'replied', call: 'c3' as never, sessionId: 's', text: CHANGES, usage: zero, ms: 1 }, 1400, 'executor')
      assert.equal(s.store.get('t1')!.question?.source, 'loop')
      const lock = runner ? acquire(s.locksDir, 't1') : undefined
      const d = (await (await fetch(`${s.base}/api/tasks/t1`)).json()) as TaskDetail
      assert.equal(d.runnerAlive, runner)
      const r = await post(s.base, { questionId: d.question!.id, text: '先别管测试' })
      assert.deepEqual(await r.json(), { ok: true, resumeNeeded: !runner })
      assert.equal(s.store.get('t1')!.pending?.purpose, 'instruct')
      if (lock && 'release' in lock) lock.release()
    } finally {
      await s.close()
    }
  }
})
