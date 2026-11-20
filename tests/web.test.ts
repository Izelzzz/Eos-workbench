import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { acquire } from '../src/runner/lock.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store/store.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import { createWebServer } from '../src/web/server.ts'
import type { TaskDetail } from '../src/web/types.ts'
import { FakeExecutor } from './fake-executor.ts'
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
  const worktree = join(dir, 'wt')
  mkdirSync(worktree)
  for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: worktree })
  store.create({ id: 't1', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: { repo: worktree, worktree, branch: 'eos/t1', baseSha: 'abc' } }, 1000)
  const replayed: string[] = []
  // c1 跑在事件流之前（只能回放），c2 运行时记录了事件流。
  store.dispatch('t1', { kind: 'replied', call: 'c1' as never, sessionId: 's', text: '方案', usage: zero, ms: 100 }, 1100, 'executor')
  store.appendTrace('t1', 'c2', [{ kind: 'call_start', t: 1200 }, { kind: 'step_start', t: 1201, step: 1 }])
  const replay = { traceOf: async (key: string, nonce: string): Promise<TraceEvent[]> => { replayed.push(`${key} ${nonce}`); return [{ kind: 'call_start', t: 1000 }, { kind: 'step_start', t: 1001, step: 1 }, { kind: 'step_end', t: 1090, step: 1 }] } }
  const supervisor = new Supervisor({ store, executor: new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : '回复')), dataDir: dir, pollMs: 5 })
  const locksDir = supervisor.locksDir
  const server = createWebServer({ store, supervisor, replay, staticDir: join(dir, 'static') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, dir, store, supervisor, replayed, locksDir, close: () => new Promise(r => server.close(r)) }
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
    assert.equal((await fetch(`${s.base}/api/tasks`, { method: 'PUT' })).status, 405)
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

/** fetch 不允许改 Host，用 node:http 模拟 DNS 重绑定：请求打到 127.0.0.1，Host 和 Origin 却是攻击者的域名。 */
const raw = (base: string, method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(base)
    const r = request({ host: u.hostname, port: u.port, method, path, headers }, res => {
      let b = ''
      res.on('data', c => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    r.on('error', reject)
    r.end(body)
  })

test('requests whose Host is not a local address are refused, which stops DNS rebinding', async () => {
  const s = await serve()
  try {
    s.store.dispatch('t1', { kind: 'asked', call: 'c2' as never, question: { id: 'n', text: '?' } }, 1250, 'executor')
    const port = new URL(s.base).port
    const evil = { host: `evil.example:${port}`, origin: `http://evil.example:${port}` }
    const read = await raw(s.base, 'GET', '/api/tasks/t1', evil)
    assert.equal(read.status, 421)
    assert.doesNotMatch(read.body, /需求/)
    const write = await raw(s.base, 'POST', '/api/tasks/t1/answer', { ...evil, 'content-type': 'application/json' }, JSON.stringify({ questionId: 'q1', text: 'x' }))
    assert.equal(write.status, 421)
    assert.equal(s.store.get('t1')!.status, 'waiting_user')
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) assert.equal((await raw(s.base, 'GET', '/api/tasks', { host })).status, 200, host)
  } finally {
    await s.close()
  }
})

const postTo = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })

test('the page can list workflows, create a task that starts running, and gets Chinese errors for bad input', async () => {
  const s = await serve()
  try {
    const wfs = await (await fetch(`${s.base}/api/workflows`)).json()
    assert.equal(wfs[0].name, 'feature')
    assert.deepEqual(wfs[0].nodes, ['plan', 'build', 'review'])
    const repo = join(s.dir, 'repo')
    mkdirSync(repo)
    for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: repo })
    const bad = await postTo(s.base, '/api/tasks', { repo: join(s.dir, 'static'), workflow: 'feature', request: 'x' })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /不是 git 仓库/)
    const r = await postTo(s.base, '/api/tasks', { repo, workflow: 'feature', request: '加一个函数' })
    assert.equal(r.status, 201)
    const { id } = await r.json()
    await s.supervisor.idle()
    assert.equal(s.store.get(id)!.status, 'done', 'the fake executor finished the workflow')
  } finally {
    await s.close()
  }
})

test('resume, retry and abort act on existing tasks and refuse what does not apply', async () => {
  const s = await serve()
  try {
    // t1 进行中、没有 runner：继续会在服务里跑起来（假执行器把它跑完）
    const resume = await postTo(s.base, '/api/tasks/t1/resume', {})
    assert.equal(resume.status, 200)
    await s.supervisor.idle()
    assert.equal(s.store.get('t1')!.status, 'done')
    const again = await postTo(s.base, '/api/tasks/t1/resume', {})
    assert.equal(again.status, 409)
    assert.equal((await again.json()).error, '只有进行中的任务可以继续')
    assert.equal((await postTo(s.base, '/api/tasks/t1/retry', {})).status, 409)
    assert.equal((await postTo(s.base, '/api/tasks/t1/abort', {})).status, 409)
    assert.equal((await postTo(s.base, '/api/tasks/nope/resume', {})).status, 404)
    assert.equal((await postTo(s.base, '/api/tasks/t1/explode', {})).status, 404)
    const crossSite = await fetch(`${s.base}/api/tasks/t1/abort`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    assert.equal(crossSite.status, 403)
  } finally {
    await s.close()
  }
})

test('a failed task is retried from the page and a running one can be aborted', async () => {
  const s = await serve()
  try {
    s.store.dispatch('t1', { kind: 'call_failed', call: 'c2' as never, error: '网络错误' }, 1300, 'executor')
    const retry = await postTo(s.base, '/api/tasks/t1/retry', {})
    assert.equal(retry.status, 200)
    await s.supervisor.idle()
    assert.equal(s.store.get('t1')!.status, 'done')
    assert.equal(s.store.events('t1').filter(e => e.event.kind === 'retry').at(-1)?.actor, 'web')
  } finally {
    await s.close()
  }
  const t = await serve()
  try {
    const abort = await postTo(t.base, '/api/tasks/t1/abort', {})
    assert.equal(abort.status, 200)
    assert.equal(t.store.get('t1')!.status, 'aborted')
  } finally {
    await t.close()
  }
})

test('team conventions: list, validate without saving, save new versions, read history; tasks record the versions they used', async () => {
  const s = await serve()
  try {
    const list = await (await fetch(`${s.base}/api/conventions`)).json()
    assert.ok(list.workflows.some((w: { name: string; version: number }) => w.name === 'feature' && w.version === 1))
    assert.ok(list.docs.some((d: { name: string }) => d.name === '研发约定'))
    const docUrl = `/api/conventions/doc/${encodeURIComponent('评审约定')}`
    assert.equal((await fetch(`${s.base}${docUrl}`)).status, 404)
    const created = await postTo(s.base, docUrl, { content: '# 评审约定\n只报告真实问题', note: '初版' })
    assert.equal(created.status, 201)
    assert.deepEqual(await created.json(), { ok: true, version: 1 })

    const wf = `name: team\ndocs: [评审约定]\nroles:\n  dev: { prompt: 写代码, write: worktree }\nnodes:\n  - { id: build, kind: agent, role: dev, task: 实现 }\n`
    const invalid = await postTo(s.base, '/api/conventions/workflow/team', { content: wf.replace('kind: agent', 'kind: robot'), validateOnly: true })
    assert.equal(invalid.status, 200)
    const v = await invalid.json()
    assert.equal(v.ok, false)
    assert.equal(v.errors[0].path, 'nodes[0].kind')
    assert.match(v.errors[0].message, /agent 或 dialog/)
    assert.equal((await fetch(`${s.base}/api/conventions/workflow/team`)).status, 404, 'validateOnly saved nothing')
    assert.deepEqual(await (await postTo(s.base, '/api/conventions/workflow/team', { content: wf, validateOnly: true })).json(), { ok: true })
    assert.equal((await postTo(s.base, '/api/conventions/workflow/team', { content: wf })).status, 201)
    const rejected = await postTo(s.base, '/api/conventions/workflow/team', { content: wf.replace('评审约定', '没有这个') })
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).errors[0].path, 'docs[0]')

    await postTo(s.base, docUrl, { content: '# 评审约定\n只报告真实问题\n给出修改建议' })
    const history = await (await fetch(`${s.base}${docUrl}`)).json()
    assert.deepEqual(history.versions.map((r: { version: number; note: string; actor: string }) => [r.version, r.note, r.actor]), [[2, '', 'web'], [1, '初版', 'web']])

    const cross = await fetch(`${s.base}${docUrl}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ content: 'x' }) })
    assert.equal(cross.status, 403, 'conventions are written only from the page itself')

    const repo = join(s.dir, 'repo')
    mkdirSync(repo)
    for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: repo })
    const task = await postTo(s.base, '/api/tasks', { repo, workflow: 'team', request: '加一个函数' })
    const { id } = await task.json()
    await s.supervisor.idle()
    const d = (await (await fetch(`${s.base}/api/tasks/${id}`)).json()) as TaskDetail
    assert.deepEqual(d.conventions, { workflow: { name: 'team', version: 1 }, docs: [{ name: '评审约定', version: 2 }] })
  } finally {
    await s.close()
  }
})
