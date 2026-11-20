import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store/store.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import { createWebServer } from '../src/web/server.ts'
import type { TaskDetail } from '../src/web/types.ts'
import { PASS, workflow } from './helpers.ts'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const serve = async () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-web-'))
  mkdirSync(join(dir, 'static'))
  writeFileSync(join(dir, 'static', 'index.html'), '<html>eos</html>')
  writeFileSync(join(dir, 'secret.txt'), 'do not serve')
  const store = new Store(join(dir, 'eos.db'))
  store.create({ id: 't1', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: { repo: '/r', worktree: '/w', branch: 'eos/t1', baseSha: 'abc' } }, 1000)
  const replayed: string[] = []
  // c1 跑在事件流之前（只能回放），c2 运行时记录了事件流。
  store.dispatch('t1', { kind: 'replied', call: 'c1' as never, sessionId: 's', text: '方案', usage: zero, ms: 100 }, 1100, 'executor')
  store.appendTrace('t1', 'c2', [{ kind: 'call_start', t: 1200 }, { kind: 'step_start', t: 1201, step: 1 }])
  const replay = { traceOf: async (key: string, nonce: string): Promise<TraceEvent[]> => { replayed.push(`${key} ${nonce}`); return [{ kind: 'call_start', t: 1000 }, { kind: 'step_start', t: 1001, step: 1 }, { kind: 'step_end', t: 1090, step: 1 }] } }
  const server = createWebServer({ store, replay, staticDir: join(dir, 'static') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, store, replayed, close: () => new Promise(r => server.close(r)) }
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
