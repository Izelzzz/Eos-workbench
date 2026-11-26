import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { acquire } from '../src/runner/lock.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { execFileSync } from 'node:child_process'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { Store } from '../src/store/store.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import { createWebServer, listenPlan, parsePublicUrl } from '../src/web/server.ts'
import { parseMasterKey, type MasterKey } from '../src/credentials/key.ts'
import { Credentials } from '../src/credentials/store.ts'
import { LOCAL_OWNER } from '../src/credentials/types.ts'
import type { CredentialsResponse } from '../src/web/types.ts'
import type { Insights } from '../src/engine/insights.ts'
import { Proposals } from '../src/improve/proposals.ts'
import type { ProposalDetail, ProposalInfo, TaskDetail } from '../src/web/types.ts'
import { FakeExecutor } from './fake-executor.ts'
import type { Executor } from '../src/executor/types.ts'
import { builtinAgentSource } from '../src/workflow/templates.ts'
import type { GenerateResponse, ImprovementComparison } from '../src/web/types.ts'
import { CHANGES, PASS, workflow } from './helpers.ts'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const serve = async (improve?: Executor, publicUrl?: URL, masterKey?: MasterKey) => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-web-'))
  mkdirSync(join(dir, 'static'))
  writeFileSync(join(dir, 'static', 'index.html'), '<html>eos</html>')
  writeFileSync(join(dir, 'secret.txt'), 'do not serve')
  mkdirSync(join(dir, 'static-evil'))
  writeFileSync(join(dir, 'static-evil', 'x.txt'), 'sibling secret')
  const store = new Store(join(dir, 'eos.db'))
  // 和平台一样用真实的 git worktree：平台提交前会核对 worktree 的 .git 还是 git 建的那个文件。
  const mainRepo = join(dir, 'main-repo')
  mkdirSync(mainRepo)
  for (const a of [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'],
  ])
    execFileSync('git', a, { cwd: mainRepo })
  const worktree = join(dir, 'wt')
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'eos/t1', worktree], { cwd: mainRepo })
  store.create({ id: 't1', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: { repo: mainRepo, worktree, branch: 'eos/t1', baseSha: 'abc' } }, 1000)
  const replayed: string[] = []
  // c1 跑在事件流之前（只能回放），c2 运行时记录了事件流。
  store.dispatch('t1', { kind: 'replied', call: 'c1' as never, sessionId: 's', text: '方案', usage: zero, ms: 100 }, 1100, 'executor')
  store.appendTrace('t1', 'c2', [
    { kind: 'call_start', t: 1200 },
    { kind: 'step_start', t: 1201, step: 1 },
  ])
  const replay = {
    traceOf: async (key: string, nonce: string): Promise<TraceEvent[]> => {
      replayed.push(`${key} ${nonce}`)
      return [
        { kind: 'call_start', t: 1000 },
        { kind: 'step_start', t: 1001, step: 1 },
        { kind: 'step_end', t: 1090, step: 1 },
      ]
    },
  }
  const supervisor = new Supervisor({ store, executor: new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : '回复')), dataDir: dir, pollMs: 5 })
  const locksDir = supervisor.locksDir
  const credentials = new Credentials(join(dir, 'eos.db'), masterKey)
  const server = createWebServer({
    store,
    supervisor,
    replay,
    staticDir: join(dir, 'static'),
    credentials,
    ...(improve === undefined ? {} : { improve: { executor: improve, dataDir: dir } }),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    dir,
    store,
    credentials,
    supervisor,
    replayed,
    locksDir,
    close: () =>
      new Promise(r =>
        server.close(() => {
          credentials.close()
          r(undefined)
        }),
      ),
  }
}

test('lists tasks and returns a detail with the trace tree, replaying calls recorded before the trace existed', async () => {
  const s = await serve()
  try {
    const list = await (await fetch(`${s.base}/api/tasks`)).json()
    assert.deepEqual(
      list.map((t: { id: string }) => t.id),
      ['t1'],
    )
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

test('with a public URL, its host is accepted and only its exact origin may write; other hosts are still refused', async () => {
  const s = await serve(undefined, new URL('https://eos.example.com'))
  try {
    s.store.dispatch('t1', { kind: 'asked', call: 'c2' as never, question: { id: 'q1', text: '?' } }, 1250, 'executor')
    const port = new URL(s.base).port
    const host = 'eos.example.com'
    const answer = (headers: Record<string, string>) =>
      raw(s.base, 'POST', '/api/tasks/t1/answer', { 'content-type': 'application/json', ...headers }, JSON.stringify({ questionId: 'q1', text: '用方案 A' }))
    assert.equal((await raw(s.base, 'GET', '/api/tasks', { host })).status, 200)
    assert.equal((await raw(s.base, 'GET', '/api/tasks', { host: `localhost:${port}` })).status, 200, 'local access keeps working')
    assert.equal((await raw(s.base, 'GET', '/api/tasks', { host: `evil.example:${port}` })).status, 421)
    assert.equal((await raw(s.base, 'GET', '/api/tasks', { host: 'eos.example.com:8443' })).status, 421, 'a different port is a different origin')
    for (const same of ['EOS.Example.com', 'eos.example.com:443'])
      assert.equal((await raw(s.base, 'GET', '/api/tasks', { host: same })).status, 200, `${same} is the same host as forwarded by some proxies`)
    for (const odd of ['eos.example.com/x', 'evil.example@eos.example.com', 'eos.example.com#x', 'eos%2eexample.com', 'eos.exa\tmple.com', 'eos.example.com:0443'])
      assert.equal((await raw(s.base, 'GET', '/api/tasks', { host: odd })).status, 421, odd)
    // 外部地址是 https：同名的 http Origin、没有 Origin、本机 Origin 配外部 Host 都不算同源。
    assert.equal((await answer({ host, origin: 'http://eos.example.com' })).status, 403)
    assert.equal((await answer({ host })).status, 403)
    assert.equal((await answer({ host, origin: `http://localhost:${port}` })).status, 403)
    const rewritten = await answer({ host: `localhost:${port}`, origin: 'https://eos.example.com' })
    assert.equal(rewritten.status, 403)
    assert.match(rewritten.body, /反向代理要把原始 Host 传过来/, 'a proxy that rewrites Host gets an explanation, not a bare refusal')
    assert.equal(s.store.get('t1')!.status, 'waiting_user', 'none of the refused writes reached the task')
    assert.equal((await answer({ host, origin: 'https://eos.example.com' })).status, 200)
    assert.equal(s.store.get('t1')!.status, 'running')
  } finally {
    await s.close()
  }
})

test('the listen address decides the printed address and the warning; an address nobody can reach without a public URL is refused', () => {
  const pub = new URL('https://eos.example.com')
  assert.deepEqual(listenPlan('127.0.0.1', 4317, undefined), { url: 'http://127.0.0.1:4317', exposed: false })
  assert.deepEqual(listenPlan('::1', 4317, undefined), { url: 'http://[::1]:4317', exposed: false })
  assert.deepEqual(listenPlan('0.0.0.0', 4317, undefined), { url: 'http://localhost:4317', exposed: true })
  assert.deepEqual(listenPlan('::', 4317, undefined), { url: 'http://localhost:4317', exposed: true })
  assert.deepEqual(listenPlan('0.0.0.0', 4317, pub), { url: 'https://eos.example.com', exposed: true })
  assert.deepEqual(listenPlan('10.0.0.5', 4317, pub), { url: 'https://eos.example.com', exposed: true })
  for (const host of ['10.0.0.5', '127.0.0.2']) assert.equal(typeof listenPlan(host, 4317, undefined), 'string', host)
})

test('the public URL must be a bare http(s) origin', () => {
  assert.equal((parsePublicUrl('https://eos.example.com/') as URL).origin, 'https://eos.example.com')
  assert.equal((parsePublicUrl('http://localhost:8080') as URL).host, 'localhost:8080')
  assert.equal((parsePublicUrl('HTTPS://EOS.Example.com:443') as URL).host, 'eos.example.com', 'default port and case are normalized like the browser does')
  for (const bad of ['eos.example.com', 'ftp://eos.example.com', 'https://eos.example.com/eos', 'https://eos.example.com/?a=1', 'https://u:p@eos.example.com'])
    assert.equal(typeof parsePublicUrl(bad), 'string', bad)
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

const postTo = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })

test('the page can list workflows, create a task that starts running, and gets Chinese errors for bad input', async () => {
  const s = await serve()
  try {
    const wfs = await (await fetch(`${s.base}/api/workflows`)).json()
    assert.equal(wfs[0].name, 'feature')
    assert.deepEqual(wfs[0].nodes, ['plan', 'build', 'review'])
    const repo = join(s.dir, 'repo')
    mkdirSync(repo)
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'],
    ])
      execFileSync('git', a, { cwd: repo })
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
    assert.equal(
      s.store
        .events('t1')
        .filter(e => e.event.kind === 'retry')
        .at(-1)?.actor,
      'web',
    )
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
    assert.match(v.errors[0].message, /agent、dialog 或 gate/)
    assert.equal((await fetch(`${s.base}/api/conventions/workflow/team`)).status, 404, 'validateOnly saved nothing')
    assert.deepEqual(await (await postTo(s.base, '/api/conventions/workflow/team', { content: wf, validateOnly: true })).json(), { ok: true })
    assert.equal((await postTo(s.base, '/api/conventions/workflow/team', { content: wf })).status, 201)
    const rejected = await postTo(s.base, '/api/conventions/workflow/team', { content: wf.replace('评审约定', '没有这个') })
    assert.equal(rejected.status, 400)
    assert.equal((await rejected.json()).errors[0].path, 'docs[0]')

    await postTo(s.base, docUrl, { content: '# 评审约定\n只报告真实问题\n给出修改建议' })
    const history = await (await fetch(`${s.base}${docUrl}`)).json()
    assert.deepEqual(
      history.versions.map((r: { version: number; note: string; actor: string }) => [r.version, r.note, r.actor]),
      [
        [2, '', 'web'],
        [1, '初版', 'web'],
      ],
    )

    const cross = await fetch(`${s.base}${docUrl}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ content: 'x' }) })
    assert.equal(cross.status, 403, 'conventions are written only from the page itself')

    const repo = join(s.dir, 'repo')
    mkdirSync(repo)
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'],
    ])
      execFileSync('git', a, { cwd: repo })
    const task = await postTo(s.base, '/api/tasks', { repo, workflow: 'team', request: '加一个函数' })
    const { id } = await task.json()
    await s.supervisor.idle()
    const d = (await (await fetch(`${s.base}/api/tasks/${id}`)).json()) as TaskDetail
    assert.deepEqual(d.conventions, { workflow: { name: 'team', version: 1 }, docs: [{ name: '评审约定', version: 2 }], templates: [], skills: [] })
    assert.ok(d.metrics.stages.length >= 1, 'the task page gets per-stage metrics')
    assert.equal(d.metrics.total.calls, d.report.total.calls, 'stage metrics count the same calls as the report')
    assert.equal(d.metrics.total.wallMs + d.metrics.betweenMs, d.metrics.elapsedMs)
    const ins = (await (await fetch(`${s.base}/api/insights`)).json()) as Insights
    const team = ins.byWorkflow.find(w => w.workflow === 'team')!
    assert.deepEqual(
      [team.tasks, team.calls, team.usage, team.agentMs, team.wallMs],
      [1, d.report.total.calls, d.metrics.total.usage, d.metrics.total.agentMs, d.metrics.total.wallMs],
      'the stats page sums the same task',
    )
    assert.equal(ins.tasks.total, (await (await fetch(`${s.base}/api/tasks`)).json()).length)
  } finally {
    await s.close()
  }
})

const TEMPLATE = `name: auditor
description: 审计：只读核对
model: deepseek-flash
write: none
tools:
  deny: [subagent]
skills: [audit-notes]
prompt: 你是审计员，不要修改任何文件。
`

const SKILL = `---
name: audit-notes
description: 写审计结论时使用
---
# 审计结论的写法

逐条写：核对了什么、结论、证据。
`

test('agent templates and skills are listed, validated without saving, saved as versions, and recorded on the tasks that use them', async () => {
  const s = await serve()
  try {
    const list = await (await fetch(`${s.base}/api/conventions`)).json()
    assert.deepEqual(
      list.templates.map((t: { name: string; version: number; write?: string; description?: string }) => [t.name, t.version, t.write, t.description]),
      [
        ['developer', 1, 'worktree', '开发：按规格实现并补测试，只改代码、测试和改动说明。'],
        ['improver', 1, 'none', '改进：从任务里程序归纳的证据出发，提出团队约定（模板、技能、约定文档、工作流）的修改提案，只读、不用工具。'],
        ['reviewer', 1, 'none', '评审：独立核对改动是否满足规格，只读。'],
        ['spec-writer', 1, 'worktree', '规格作者：把需求整理成可执行、可验证的规格，只写 docs/ 下的规格文件。'],
      ],
      'the seeded templates come with their description and write scope',
    )
    assert.deepEqual(
      list.skills.map((k: { name: string; version: number; description?: string }) => [k.name, k.version]),
      [['write-changes', 1]],
    )
    assert.match(list.skills[0].description, /改动说明/)

    // 技能名必须和 frontmatter 里的 name 一致，正文不能空；错误带位置。
    const skillUrl = '/api/conventions/skill/audit-notes'
    const noBody = await postTo(s.base, skillUrl, { content: SKILL.replace(/# 审计结论[\s\S]*$/, ''), validateOnly: true })
    assert.equal(noBody.status, 200)
    assert.deepEqual(await noBody.json(), { ok: false, errors: [{ path: '(正文)', message: '技能正文不能为空' }] })
    const misnamed = await postTo(s.base, skillUrl, { content: SKILL.replace('name: audit-notes', 'name: other'), validateOnly: true })
    const mis = await misnamed.json()
    assert.equal(mis.errors[0].path, 'name')
    assert.match(mis.errors[0].message, /和要保存的「audit-notes」不一致/)
    assert.equal((await fetch(`${s.base}${skillUrl}`)).status, 404, 'validateOnly saved nothing')

    // 模板引用的技能还不存在：报错指到 skills[0]。
    const dangling = await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE, validateOnly: true })
    const dang = await dangling.json()
    assert.equal(dang.ok, false)
    assert.deepEqual(dang.errors, [{ path: 'skills[0]', message: '平台上没有名为「audit-notes」的技能' }])

    // 先存技能，模板才能通过。
    assert.equal((await postTo(s.base, skillUrl, { content: SKILL, note: '初版' })).status, 201)
    assert.deepEqual(await (await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE, validateOnly: true })).json(), { ok: true })

    // 模板自身的字段错误：只读角色不能写 writePaths；工具组只能是固定几个。
    const readonlyWrite = await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE.replace('write: none', 'write: none\nwritePaths: [src/**]'), validateOnly: true })
    const rw = await readonlyWrite.json()
    assert.equal(rw.errors[0].path, 'writePaths')
    assert.match(rw.errors[0].message, /只读（write: none）的角色不需要 writePaths/)
    const badGroup = await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE.replace('deny: [subagent]', 'deny: [网络]'), validateOnly: true })
    const bg = await badGroup.json()
    assert.equal(bg.errors[0].path, 'tools.deny[0]')
    assert.match(bg.errors[0].message, /只能是 web、subagent、bash、schedule、todo、goal 之一/)

    assert.deepEqual(await (await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE, note: '初版' })).json(), { ok: true, version: 1 })
    const again = await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE })
    assert.equal(again.status, 400)
    assert.match((await again.json()).errors[0].message, /内容和当前版本完全一样/)
    assert.equal((await postTo(s.base, '/api/conventions/template/auditor', { content: TEMPLATE.replace('deny: [subagent]', 'deny: [subagent, web]'), note: '也禁联网' })).status, 201)
    const history = await (await fetch(`${s.base}/api/conventions/template/auditor`)).json()
    assert.equal(history.kind, 'template')
    assert.deepEqual(
      history.versions.map((r: { version: number; note: string }) => [r.version, r.note]),
      [
        [2, '也禁联网'],
        [1, '初版'],
      ],
    )
    assert.match(history.versions[1].content, /deny: \[subagent\]/, 'the first version is kept so the page can diff it')

    // 工作流用模板当角色：任务记下模板和技能各自用了哪一版。
    const wf = 'name: audit\nroles:\n  checker: { template: auditor }\nnodes:\n  - { id: build, kind: agent, role: checker, task: 核对 }\n'
    assert.equal((await postTo(s.base, '/api/conventions/workflow/audit', { content: wf })).status, 201)
    const repo = join(s.dir, 'repo')
    mkdirSync(repo)
    for (const a of [
      ['init', '-q', '-b', 'main'],
      ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'],
    ])
      execFileSync('git', a, { cwd: repo })
    const task = await postTo(s.base, '/api/tasks', { repo, workflow: 'audit', request: '核对改动' })
    const { id } = await task.json()
    await s.supervisor.idle()
    const d = (await (await fetch(`${s.base}/api/tasks/${id}`)).json()) as TaskDetail
    assert.deepEqual(d.conventions?.templates, [{ name: 'auditor', version: 2 }])
    assert.deepEqual(d.conventions?.skills, [{ name: 'audit-notes', version: 1 }])
  } finally {
    await s.close()
  }
})

test('proposals: list and detail with the base version for diffing; approve and reject need same-origin JSON; stale and repeated decisions are 409', async () => {
  const s = await serve()
  try {
    const dev = s.store.convention('template', 'developer')!
    const add = (rationale: string) =>
      new Proposals(s.store, s.supervisor.conventions).add(
        {
          target: { kind: 'template', name: 'developer' },
          baseVersion: dev.version,
          content: dev.content.replace(/prompt: \|/, 'prompt: |\n  导出函数要写 @example。'),
          rationale,
          evidence: ['t1:9'],
          scope: { workflow: 'standard', tasks: ['t1'] },
          actor: 'cli',
        },
        2000,
      )
    assert.ok(add('第一条').ok)
    assert.ok(add('第二条').ok)
    const list = (await (await fetch(`${s.base}/api/improve/proposals`)).json()) as ProposalInfo[]
    assert.deepEqual(
      list.map(p => [p.id, p.status, p.latestVersion]),
      [
        [2, 'pending', 1],
        [1, 'pending', 1],
      ],
    )
    const d = (await (await fetch(`${s.base}/api/improve/proposals/1`)).json()) as ProposalDetail
    assert.deepEqual([d.base?.version, d.base?.content === dev.content, d.rationale], [1, true, '第一条'])
    assert.equal((await fetch(`${s.base}/api/improve/proposals/9`)).status, 404)

    const decide = (id: number, action: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', origin: s.base }) =>
      fetch(`${s.base}/api/improve/proposals/${id}/${action}`, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal((await decide(1, 'approve', {}, { 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403)
    assert.equal((await decide(1, 'reject', { reason: '跨站' }, { 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403)
    assert.equal(s.store.convention('template', 'developer')!.version, 1, 'a cross-site request changes nothing')
    assert.equal(s.store.proposal(1)!.status, 'pending')
    assert.equal((await decide(1, 'reject', {})).status, 400)
    assert.equal((await decide(1, 'reject', { reason: '   ' })).status, 400)
    const ok = await decide(1, 'approve', { note: '试一下' })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { proposal: { status: string } }).proposal.status, 'approved')
    assert.equal(s.store.convention('template', 'developer')!.note, '改进提案 #1：第一条；试一下')
    assert.equal(s.store.convention('template', 'developer')!.actor, 'web')
    const twice = await decide(1, 'approve', {})
    assert.deepEqual([twice.status, ((await twice.json()) as { error: string }).error], [409, '提案 #1 已批准，不能再审批'])
    const stale = await decide(2, 'approve', {})
    assert.deepEqual([stale.status, ((await stale.json()) as { error: string }).error], [409, '提案 #2 已过期：目标已是第 2 版，提案基于第 1 版。请重新生成提案'])
    assert.equal((await decide(9, 'reject', { reason: '无' })).status, 404)
    const after = (await (await fetch(`${s.base}/api/improve/proposals`)).json()) as ProposalInfo[]
    assert.deepEqual(
      after.map(p => [p.id, p.status, p.latestVersion]),
      [
        [2, 'stale', 2],
        [1, 'approved', 2],
      ],
    )
    // 内容在批准时已无法保存（工作流引用的模板被换成解析不了的版本）：409，保持待审批。
    const wf = s.store.convention('workflow', 'standard')!
    const r3 = new Proposals(s.store, s.supervisor.conventions).add(
      {
        target: { kind: 'workflow', name: 'standard' },
        baseVersion: wf.version,
        content: wf.content + '\n',
        rationale: '第三条',
        evidence: ['t1:9'],
        scope: { workflow: 'standard', tasks: ['t1'] },
        actor: 'cli',
      },
      3000,
    )
    assert.ok(r3.ok)
    s.store.saveConvention({ kind: 'template', name: 'developer', content: 'name: developer\nprompt: x\nwrite: everywhere\n', note: '', actor: 'test' }, 3001)
    const invalid = await decide(r3.row.id, 'approve', {})
    assert.equal(invalid.status, 409)
    assert.match(((await invalid.json()) as { error: string }).error, /^新内容现在不能批准：/)
    assert.equal(s.store.proposal(r3.row.id)!.status, 'pending')
  } finally {
    await s.close()
  }
})

test('generating proposals from the page: one run at a time, the detail carries the cited evidence, and errors are reported', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(r => {
    release = r
  })
  const reply = () =>
    '```json\n' +
    JSON.stringify({
      proposals: [{ target: { kind: 'template', name: 'developer' }, rationale: '评审要求补测试', evidence: ['t2:2'], content: `${builtinAgentSource('developer').trimEnd()}\n  - 先写测试。\n` }],
    }) +
    '\n```'
  const improver = new FakeExecutor(async () => {
    await gate
    return reply()
  })
  const s = await serve(improver)
  try {
    // 一个用 developer 模板、评审要求过一次修改的已完成任务。
    const w = workflow({ maxRounds: 2, escalate: false })
    const wf = { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version: 1 } } } }
    s.store.create({ id: 't2', request: '需求', workflow: wf, workflowSource: 'y', meta: { repo: 'r', worktree: 'w', branch: 'b', baseSha: 'x' } }, 2000)
    for (const text of ['方案', '实现', CHANGES, '改了', PASS]) {
      const p = s.store.get('t2')!.pending!
      s.store.dispatch('t2', { kind: 'replied', call: p.id, sessionId: 's', text, usage: zero, ms: 5 }, 2001, 'executor')
    }
    assert.equal(s.store.get('t2')!.status, 'done')
    const gen = (body: unknown) => fetch(`${s.base}/api/improve/generate`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.base }, body: JSON.stringify(body) })
    assert.equal((await gen({})).status, 400)
    const first = gen({ workflow: 't' })
    // 等第一个请求拿到锁（不靠固定的等待时间）。
    for (let i = 0; i < 200 && !existsSync(join(s.dir, 'locks', 'improve.pid')); i++) await new Promise(r => setTimeout(r, 10))
    const second = await gen({ workflow: 't' })
    assert.deepEqual([second.status, ((await second.json()) as { error: string }).error], [409, `已经有一次生成在进行（网页或命令行发起的，进程 ${process.pid}），等它结束再试`])
    release()
    const done = (await (await first).json()) as GenerateResponse
    assert.ok(done.ok)
    assert.deepEqual(
      done.created.map(p => [p.id, p.target.name, p.evidence, p.actor]),
      [[1, 'developer', ['t2:2'], 'web']],
    )
    assert.equal(done.call?.usage.output, 10)
    const d = (await (await fetch(`${s.base}/api/improve/proposals/1`)).json()) as ProposalDetail
    assert.deepEqual(
      d.signals.map(x => [x.id, x.kind, x.role, x.text]),
      [['t2:2', 'review_changes', 'dev', '缺少测试\n1. [major]：补测试']],
    )
    const missing = await gen({ workflow: 't', tasks: ['nope'] })
    assert.deepEqual([missing.status, ((await missing.json()) as { error: string }).error], [400, '这些任务不存在或不是工作流「t」的：nope'])
  } finally {
    release()
    await s.close()
  }
})

test('without an improver executor the generate endpoint says so', async () => {
  const s = await serve()
  try {
    const r = await fetch(`${s.base}/api/improve/generate`, { method: 'POST', headers: { 'content-type': 'application/json', origin: s.base }, body: JSON.stringify({ workflow: 't' }) })
    assert.equal(r.status, 503)
  } finally {
    await s.close()
  }
})

test('generate: a cross-site request is refused; a failed model call is 502 with usage and the reply head, and the lock is released', async () => {
  let mode: 'throw' | 'tools' = 'throw'
  const ex: Executor = {
    async send(p) {
      if (mode === 'throw') throw new Error('连接被重置')
      p.onEvent?.({ kind: 'tool_start', t: 1, step: 1, id: 'x', name: 'read', args: '{}' })
      return { sessionId: 's', text: '我先读一下文件……', usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }, ms: 9 }
    },
    async findReply() {
      return undefined
    },
    async traceOf() {
      return []
    },
    async release() {},
    async close() {},
  }
  const s = await serve(ex)
  try {
    const w = workflow({ maxRounds: 2, escalate: false })
    s.store.create(
      {
        id: 't2',
        request: '需求',
        workflow: { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version: 1 } } } },
        workflowSource: 'y',
        meta: { repo: 'r', worktree: 'w', branch: 'b', baseSha: 'x' },
      },
      2000,
    )
    for (const text of ['方案', '实现', CHANGES, '改了', PASS])
      s.store.dispatch('t2', { kind: 'replied', call: s.store.get('t2')!.pending!.id, sessionId: 's', text, usage: zero, ms: 5 }, 2001, 'executor')
    const gen = (origin: string) => fetch(`${s.base}/api/improve/generate`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ workflow: 't' }) })
    assert.equal((await gen('http://evil.example')).status, 403)
    const thrown = await gen(s.base)
    assert.deepEqual([thrown.status, ((await thrown.json()) as { error: string }).error], [502, '调用 improver 失败：连接被重置'])
    assert.equal(existsSync(join(s.dir, 'locks', 'improve.pid')), false, 'the lock is released after the call failed')
    mode = 'tools'
    const tools = (await (await gen(s.base)).json()) as Extract<GenerateResponse, { ok: false }>
    assert.deepEqual([tools.call?.usage.output, tools.call?.replyHead], [3, '我先读一下文件……'])
    assert.deepEqual(s.store.proposals(), [])
  } finally {
    await s.close()
  }
})

test('comparisons: each approved proposal compares the tasks before and after its version; the detail carries it too', async () => {
  const s = await serve()
  try {
    const dev = s.store.convention('template', 'developer')!
    const p = new Proposals(s.store, s.supervisor.conventions)
    const added = p.add(
      {
        target: { kind: 'template', name: 'developer' },
        baseVersion: dev.version,
        content: `${dev.content.trimEnd()}\n  - 写 @example。\n`,
        rationale: '补规则',
        evidence: ['x:1'],
        scope: { workflow: 't', tasks: [] },
        actor: 'cli',
      },
      2000,
    )
    assert.ok(added.ok)
    const pending = (await (await fetch(`${s.base}/api/improve/proposals/1`)).json()) as ProposalDetail
    assert.equal(pending.comparison, undefined, 'no comparison before approval')
    assert.ok(p.approve(1, 2001, 'web').ok)
    const run = (id: string, version: number, replies: string[]) => {
      const w = workflow({ maxRounds: 2, escalate: false })
      s.store.create(
        {
          id,
          request: '需求',
          workflow: { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version } } } },
          workflowSource: 'y',
          meta: { repo: 'r', worktree: 'w', branch: 'b', baseSha: 'x' },
        },
        3000,
      )
      for (const text of replies) s.store.dispatch(id, { kind: 'replied', call: s.store.get(id)!.pending!.id, sessionId: 's', text, usage: { ...zero, input: 10, output: 5 }, ms: 5 }, 3001, 'executor')
    }
    for (const id of ['b1', 'b2', 'b3']) run(id, 1, ['方案', '实现', CHANGES, '改了', PASS])
    for (const id of ['a1', 'a2']) run(id, 2, ['方案', '实现', PASS])
    const list = (await (await fetch(`${s.base}/api/improve/comparisons`)).json()) as ImprovementComparison[]
    assert.equal(list.length, 1)
    const c = list[0]!.comparison
    assert.deepEqual([list[0]!.proposal.id, c.version, c.before.tasks, c.after.tasks, c.enough], [1, 2, 3, 2, false])
    assert.deepEqual([c.before.mean.reviews, c.after.mean.reviews], [2, 1])
    run('a3', 2, ['方案', '实现', PASS])
    const d = (await (await fetch(`${s.base}/api/improve/proposals/1`)).json()) as ProposalDetail
    assert.deepEqual([d.comparison?.after.tasks, d.comparison?.enough], [3, true])
  } finally {
    await s.close()
  }
})

const KEY = (parseMasterKey(Buffer.alloc(32, 5).toString('base64')) as { key: MasterKey }).key
const VALUE = 'ghp_web-test-secret-0123456789abcdef'

test('凭据：保存、替换、删除；列表和所有响应里都没有值', async () => {
  const s = await serve(undefined, undefined, KEY)
  const bodies: string[] = []
  const call = async (r: Promise<Response>) => {
    const res = await r
    const text = await res.text()
    bodies.push(text)
    return { status: res.status, body: JSON.parse(text) }
  }
  try {
    assert.deepEqual((await call(fetch(`${s.base}/api/credentials`))).body, { usable: true, keyId: KEY.id, items: [] })
    assert.deepEqual(await call(postTo(s.base, '/api/credentials', { name: 'github.com', kind: 'token', value: VALUE })), { status: 200, body: { ok: true } })
    assert.deepEqual(s.credentials.get(LOCAL_OWNER, 'github.com'), { kind: 'ok', value: VALUE }, '存进了凭据存储')
    const list = (await call(fetch(`${s.base}/api/credentials`))).body as CredentialsResponse
    assert.deepEqual(
      list.items.map(i => [i.name, i.kind, i.keyId]),
      [['github.com', 'token', KEY.id]],
    )
    assert.deepEqual(await call(postTo(s.base, '/api/credentials', { name: 'github.com', kind: 'token', value: `${VALUE}-2` })), { status: 200, body: { ok: true } })
    assert.deepEqual(s.credentials.get(LOCAL_OWNER, 'github.com'), { kind: 'ok', value: `${VALUE}-2` }, '同名替换')
    // 不合规的输入：报原因，不回显值。
    assert.equal((await call(postTo(s.base, '/api/credentials', { name: 'Bad Name', kind: 'token', value: VALUE }))).status, 400)
    assert.equal((await call(postTo(s.base, '/api/credentials', { name: 'x', kind: 'password', value: VALUE }))).status, 400)
    assert.equal((await call(postTo(s.base, '/api/credentials', { name: 'x', kind: 'token' }))).status, 400)
    assert.equal((await call(postTo(s.base, '/api/credentials', { kind: 'token', value: VALUE }))).status, 400)
    // 值误填进名字：报错不回显名字。
    const pasted = VALUE.toUpperCase()
    const misplaced = await call(postTo(s.base, '/api/credentials', { name: pasted, kind: 'token', value: 'x' }))
    assert.equal(misplaced.status, 400)
    assert.ok(!JSON.stringify(misplaced.body).includes(pasted))
    assert.deepEqual(await call(postTo(s.base, '/api/credentials/delete', { name: 'github.com' })), { status: 200, body: { ok: true } })
    assert.deepEqual(await call(postTo(s.base, '/api/credentials/delete', { name: 'github.com' })), { status: 404, body: { ok: false, error: '没有这条凭据' } })
    assert.deepEqual((await call(fetch(`${s.base}/api/credentials`))).body.items, [])
    for (const b of bodies) assert.ok(!b.includes(VALUE), b)
  } finally {
    await s.close()
  }
})

test('凭据：没有主密钥时保存返回 409 并写明怎么设置；列表带上说明', async () => {
  const s = await serve()
  try {
    const list = (await (await fetch(`${s.base}/api/credentials`)).json()) as CredentialsResponse
    assert.equal(list.usable, false)
    assert.match(list.hint ?? '', /openssl rand -base64 32/)
    const r = await postTo(s.base, '/api/credentials', { name: 'deepseek', kind: 'api-key', value: VALUE })
    assert.equal(r.status, 409)
    assert.match(((await r.json()) as { error: string }).error, /没有设置主密钥 EOS_MASTER_KEY/)
  } finally {
    await s.close()
  }
})

test('凭据：跨站请求和非 JSON 请求被挡住，什么都不改', async () => {
  const s = await serve(undefined, undefined, KEY)
  try {
    const evil = await fetch(`${s.base}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'github.com', kind: 'token', value: VALUE }),
    })
    assert.equal(evil.status, 403)
    const form = await fetch(`${s.base}/api/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: s.base },
      body: JSON.stringify({ name: 'github.com', kind: 'token', value: VALUE }),
    })
    assert.equal(form.status, 415)
    s.credentials.put(LOCAL_OWNER, 'keep', 'token', VALUE)
    const del = await fetch(`${s.base}/api/credentials/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'keep' }),
    })
    assert.equal(del.status, 403)
    assert.deepEqual(
      s.credentials.list(LOCAL_OWNER).map(i => i.name),
      ['keep'],
    )
  } finally {
    await s.close()
  }
})

test('凭据：github-app. 开头的名字只能是 GitHub App 凭据；已有的 App 凭据不能被换成别的类型', async () => {
  const s = await serve(undefined, undefined, KEY)
  try {
    const bad = await postTo(s.base, '/api/credentials', { name: 'github-app.github.com', kind: 'token', value: VALUE })
    assert.equal(bad.status, 400)
    const wrongName = await postTo(s.base, '/api/credentials', { name: 'github.com', kind: 'github-app', value: '{}' })
    assert.equal(wrongName.status, 400)
    s.credentials.put(LOCAL_OWNER, 'github-app.github.com', 'github-app', '{"appId":1,"privateKey":"x"}')
    const overwrite = await postTo(s.base, '/api/credentials', { name: 'github-app.github.com', kind: 'token', value: VALUE })
    assert.equal(overwrite.status, 400)
    assert.deepEqual(
      s.credentials.list(LOCAL_OWNER).map(i => [i.name, i.kind]),
      [['github-app.github.com', 'github-app']],
    )
  } finally {
    await s.close()
  }
})

test('卡点：任务页带上卡点信息；页面上打回（写意见）、改完回到卡点后通过，结论记成 web；过期或空意见的结论被拒绝', async () => {
  const s = await serve()
  try {
    const meta = s.store.meta('t1')
    s.store.create({ id: 't2', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false, gate: 'human' }), workflowSource: 'y', meta: { ...meta, branch: 'eos/t1' } }, 2000)
    for (const [i, text] of ['方案', '实现 v1', PASS].entries())
      assert.ok(s.store.dispatch('t2', { kind: 'replied', call: `c${i + 1}` as never, sessionId: 's', text, usage: zero, ms: 1 }, 2001 + i, 'executor').accepted)
    const get = async () => (await (await fetch(`${s.base}/api/tasks/t2`)).json()) as TaskDetail
    let d = await get()
    assert.equal(d.status, 'waiting_accept')
    assert.deepEqual(
      { ...d.gate, decisions: d.gate?.decisions.length },
      { node: 'accept', with: 'build', by: { kind: 'human' }, approver: '任何能访问平台的人', task: '验收', round: 1, phase: 'decide', waiting: true, output: '实现 v1', decisions: 0 },
    )
    const list = (await (await fetch(`${s.base}/api/tasks`)).json()) as { id: string; status: string }[]
    assert.equal(list.find(t => t.id === 't2')?.status, 'waiting_accept', '任务列表能看出在等验收')
    const gate = (body: unknown) => postTo(s.base, '/api/tasks/t2/gate', body)
    assert.equal((await gate({ gate: 'accept', round: 1, pass: false, comment: ' ' })).status, 409, '打回要写意见')
    assert.equal((await gate({ gate: 'accept', round: 2, pass: true, comment: '' })).status, 409, '过期或不存在的那一次')
    assert.equal((await gate({ gate: 'accept', round: 1 })).status, 400)
    assert.equal((await fetch(`${s.base}/api/tasks/t2/gate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, '只接受本页面的请求')
    const back = await gate({ gate: 'accept', round: 1, pass: false, comment: '补注释' })
    assert.deepEqual(await back.json(), { ok: true, resumeNeeded: false })
    // 没有 runner 在跑：接口起一个，交回开发修改，改完回到卡点（第 2 次）。
    for (let i = 0; i < 200 && (d = await get()).gate?.round !== 2; i++) await new Promise(r => setTimeout(r, 10))
    for (let i = 0; i < 200 && (d = await get()).status !== 'waiting_accept'; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(d.status, 'waiting_accept')
    assert.deepEqual(
      d.gate?.decisions.map(x => [x.round, x.by, x.pass, x.comment]),
      [[1, 'human', false, '补注释']],
    )
    assert.equal(d.gate?.output, '回复', '显示修改后的产出')
    assert.deepEqual(await (await gate({ gate: 'accept', round: 2, pass: true, comment: '可以' })).json(), { ok: true, resumeNeeded: false })
    for (let i = 0; i < 200 && (d = await get()).status !== 'done'; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(d.status, 'done')
    assert.equal(d.gate, undefined)
    const decided = s.store.events('t2').filter(e => e.event.kind === 'decided')
    assert.deepEqual(
      decided.map(e => [e.actor, e.accepted]),
      [
        ['web', false],
        ['web', false],
        ['web', true],
        ['web', true],
      ],
    )
    await s.supervisor.idle()
  } finally {
    await s.close()
  }
})
