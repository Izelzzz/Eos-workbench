import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseMasterKey, type MasterKey } from '../src/credentials/key.ts'
import { Credentials } from '../src/credentials/store.ts'
import { LOCAL_OWNER } from '../src/credentials/types.ts'
import { defaultForges, looksRemote, parseRemote } from '../src/forge/forges.ts'
import { githubForge } from '../src/forge/github.ts'
import { explain, foreignConfig, secretsOf, mirrorDir, remoteEnv, withGitConfig } from '../src/runner/mirror.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { linksOf } from '../src/web/server.ts'
import { Store } from '../src/store/store.ts'
import { FakeExecutor } from './fake-executor.ts'
import { PASS } from './helpers.ts'

const ROOT = join(import.meta.dirname, '..')
const cleanup: (() => void)[] = []
after(() => { for (const f of cleanup) f() })

const KEY = (parseMasterKey(Buffer.alloc(32, 4).toString('base64')) as { key: MasterKey }).key
const TOKEN = 'ghp_MirrorTestToken0123456789ABCDEF'

test('GitHub 地址：认 https、带 .git 或末尾 /、git@ 写法；认不出的返回 undefined', () => {
  const gh = githubForge()
  const want = { forge: 'github', host: 'github.com', owner: 'Izelzzz', name: 'eos-e2e-sandbox', cloneUrl: 'https://github.com/Izelzzz/eos-e2e-sandbox.git', webUrl: 'https://github.com/Izelzzz/eos-e2e-sandbox' }
  for (const s of ['https://github.com/Izelzzz/eos-e2e-sandbox', 'github.com/Izelzzz/eos-e2e-sandbox', 'https://github.com/Izelzzz/eos-e2e-sandbox.git', 'https://github.com/Izelzzz/eos-e2e-sandbox/', ' git@github.com:Izelzzz/eos-e2e-sandbox.git ', 'https://GitHub.com/Izelzzz/eos-e2e-sandbox']) assert.deepEqual(gh.parse(s), want, s)
  for (const s of ['https://github.com/Izelzzz', 'https://github.com/a/b/c', 'https://gitlab.com/a/b', 'http://github.com/a/b', 'https://github.com/a/..', 'https://github.com/-a/b', 'https://github.com/a/b?x=1', '/srv/repo']) assert.equal(gh.parse(s), undefined, s)
  assert.equal(gh.credentialName(want), 'github.com')
  assert.equal(gh.gitAuthHeader('t0k'), `Authorization: Basic ${Buffer.from('x-access-token:t0k').toString('base64')}`)
  assert.equal(parseRemote(defaultForges(), 'https://github.com/a/b')?.repo.name, 'b')
  assert.ok(looksRemote('https://gitlab.com/a/b') && looksRemote('git@gitlab.com:a/b.git') && !looksRemote('/srv/repo') && !looksRemote('./repo') && !looksRemote('C:\\\\repo'))
})

test('git 配置接在环境里已有的 GIT_CONFIG_* 后面', () => {
  const env = withGitConfig({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'b', GIT_CONFIG_VALUE_1: '2' }, [['c', '3']])
  assert.equal(env.GIT_CONFIG_COUNT, '3')
  assert.deepEqual([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2], ['a', 'c', '3'])
  assert.equal(withGitConfig({}, [['x', 'y']]).GIT_CONFIG_KEY_0, 'x')
})

test('git 的报错换成中文原因，报错里出现的令牌被抹掉', () => {
  const repo = githubForge().parse('https://github.com/o/r')!
  assert.match(explain(repo, 'fatal: Authentication failed', { credential: 'github.com', hasToken: true }), /github\.com 拒绝了访问 github\.com 上的 o\/r：凭据「github\.com」里的令牌无效/)
  assert.match(explain(repo, "fatal: could not read Username for 'https://github.com': terminal prompts disabled", { credential: 'github.com', hasToken: false }), /这是私有仓库或需要登录。在凭据页添加名字为「github\.com」/)
  assert.match(explain(repo, "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", { credential: 'github.com', hasToken: true }), /找不到仓库 github\.com 上的 o\/r/)
  assert.match(explain(repo, 'fatal: unable to access: Could not resolve host: github.com', { credential: 'github.com', hasToken: false }), /连不上 github\.com/)
  assert.equal(explain(repo, `fatal: weird ${TOKEN} thing`, { credential: 'github.com', hasToken: true, secrets: [TOKEN] }).includes(TOKEN), false)
  assert.match(explain(repo, "fatal: remote helper 'https' not found", { credential: 'github.com', hasToken: true }), /^访问 github\.com 上的 o\/r 失败：/, '本机 git 的问题不当成找不到仓库')
})

test('访问远程的环境：不继承宿主机的 GIT_CONFIG_PARAMETERS、GIT_SSL_NO_VERIFY，HOME 换成平台的目录，强制校验证书', () => {
  const repo = githubForge().parse('https://github.com/o/r')!
  const env = remoteEnv(repo, 'Authorization: Basic abc', '/srv/eos/git-home', { PATH: '/bin', HOME: '/root', GIT_CONFIG_PARAMETERS: "'url.x.insteadof'='https://github.com/'", GIT_SSL_NO_VERIFY: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.proxy', GIT_CONFIG_VALUE_0: 'http://proxy:3128' })
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
  assert.equal(env.GIT_SSL_NO_VERIFY, undefined)
  assert.equal(env.HOME, '/srv/eos/git-home')
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  const pairs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]))
  assert.deepEqual(pairs, { 'http.proxy': 'http://proxy:3128', 'credential.helper': '', 'http.sslVerify': 'true', 'http.lowSpeedLimit': '1000', 'http.lowSpeedTime': '60', 'http.https://github.com/.extraheader': 'Authorization: Basic abc' })
})

/** 一个"远程"：bare 仓库放在 <root>/acme/app.git，由单独进程里的 git HTTP 服务提供，可以要求令牌。 */
const remote = async (token: string | undefined, o: { empty?: boolean } = {}) => {
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.eos-mirror-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'remote')
  const bare = join(root, 'acme', 'app.git')
  mkdirSync(bare, { recursive: true })
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
  const work = join(dir, 'work')
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: work, stdio: 'ignore' })
  const commit = (file: string) => {
    writeFileSync(join(work, file), `${file}\n`)
    g('add', '-A')
    g('commit', '-q', '-m', file)
    g('push', '-q', bare, 'HEAD:main')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim()
  }
  mkdirSync(work)
  g('init', '-q', '-b', 'main')
  const first = o.empty ? '' : commit('README.md')
  const record = join(dir, 'requests.jsonl')
  writeFileSync(record, '')
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests', 'git-server-main.ts'), root, token ?? '-', record], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
  cleanup.push(() => child.kill())
  const port = await new Promise<number>(r => child.stdout!.on('data', (b: Buffer) => { const m = /port (\d+)/.exec(b.toString()); if (m) r(Number(m[1])) }))
  const forge = githubForge({ host: `127.0.0.1:${port}`, scheme: 'http' })
  const data = join(dir, 'data')
  const store = new Store(join(data, 'eos.db'))
  const credentials = new Credentials(join(data, 'eos.db'), KEY)
  cleanup.push(() => { credentials.close(); store.close() })
  const sup = new Supervisor({ store, executor: new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : '回复')), dataDir: data, credentials, forges: [forge], pollMs: 2 })
  const url = `http://127.0.0.1:${port}/acme/app`
  const requests = () => readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { path: string; auth: string | null })
  return { dir, data, store, credentials, sup, url, first, commit, requests, credential: `127.0.0.1:${port}`, forge }
}

const filesUnder = (d: string): string[] => readdirSync(d).flatMap(n => {
  const f = join(d, n)
  return statSync(f, { throwIfNoEntry: false })?.isDirectory() ? filesUnder(f) : [f]
})

test('私有远程仓库：带凭据里的令牌克隆成镜像，在默认分支最新提交上建 worktree；令牌不落盘', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const c = await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })
  assert.equal(c.ok, true, JSON.stringify(c))
  const id = (c as { id: string }).id
  const meta = r.store.meta(id)
  const repo = r.forge.parse(r.url)!
  assert.deepEqual(meta.remote, repo)
  assert.equal(meta.repo, mirrorDir(r.data, repo))
  assert.equal(meta.baseSha, r.first)
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: meta.worktree, encoding: 'utf8' }).trim(), r.first)
  assert.ok(existsSync(join(meta.worktree, 'README.md')))
  // 每个请求都带着正确的认证头（服务端只认这个格式，不对就 401）。
  const reqs = r.requests()
  assert.ok(reqs.length > 0 && reqs.every(q => q.auth === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`), JSON.stringify(reqs))
  // 数据目录里（镜像的配置、worktree、数据库、日志）找不到令牌，也找不到认证头。
  const header = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
  for (const f of filesUnder(r.data)) {
    const b = readFileSync(f)
    assert.ok(!b.includes(TOKEN) && !b.includes(header), f)
  }
  assert.doesNotMatch(readFileSync(join(meta.repo, 'config'), 'utf8'), /url|extraheader|127\.0\.0\.1/)
})

test('同一个进程里同时在同一个仓库上建两个任务：排队依次更新镜像，两个都建成', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const [a, b, c] = await Promise.all(['一', '二', '三'].map(request => r.sup.create({ repo: r.url, workflow: 'feature', request })))
  assert.deepEqual([a!.ok, b!.ok, c!.ok], [true, true, true], JSON.stringify([a, b, c]))
})

test('报错里认证头的 base64 形式也被抹掉', () => {
  const header = githubForge().gitAuthHeader(TOKEN)
  const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
  assert.deepEqual(secretsOf({ header, secret: TOKEN }), [TOKEN, b64])
  const repo = githubForge().parse('https://github.com/o/r')!
  const text = explain(repo, `fatal: odd failure\n> ${header}\n> token ${TOKEN}`, { credential: 'github.com', hasToken: true, secrets: secretsOf({ header, secret: TOKEN }) })
  assert.ok(!text.includes(TOKEN) && !text.includes(b64), text)
  assert.match(text, /\*\*\*/)
})

test('镜像的配置里有不是平台写的项（例如代理、include）：不访问远程，报出这些项', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const a = await r.sup.create({ repo: r.url, workflow: 'feature', request: '一' })
  assert.equal(a.ok, true)
  const gitDir = mirrorDir(r.data, r.forge.parse(r.url)!)
  assert.deepEqual(foreignConfig(gitDir), [])
  writeFileSync(join(gitDir, 'config'), `${readFileSync(join(gitDir, 'config'), 'utf8')}[http]\n\tproxy = http://evil:3128\n[include]\n\tpath = /tmp/x\n`)
  const before = r.requests().length
  const b = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '二' })) as { ok: boolean; error: string }
  assert.equal(b.ok, false)
  assert.match(b.error, /配置里有不是平台写的项（http\.proxy、include\.path），为了不把令牌发到别处，没有访问远程/)
  assert.equal(r.requests().length, before, '没有发出请求')
})

test('第二个任务先更新镜像：基线是远程最新的提交', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const a = await r.sup.create({ repo: r.url, workflow: 'feature', request: '一' }) as { id: string }
  const second = r.commit('NEXT.md')
  const b = await r.sup.create({ repo: r.url, workflow: 'feature', request: '二' }) as { id: string }
  assert.equal(r.store.meta(a.id).baseSha, r.first)
  assert.equal(r.store.meta(b.id).baseSha, second)
  assert.equal(r.store.meta(a.id).repo, r.store.meta(b.id).repo, '同一个镜像')
})

test('令牌无效、没有令牌、仓库不存在、空仓库：创建失败，报中文原因，不留任务', async () => {
  const r = await remote(TOKEN)
  const fail = async (repo: string) => {
    const c = await r.sup.create({ repo, workflow: 'feature', request: '需求' })
    assert.equal(c.ok, false)
    return (c as { error: string }).error
  }
  assert.match(await fail(r.url), new RegExp(`拒绝了访问 .*acme/app：这是私有仓库或需要登录。在凭据页添加名字为「${r.credential}」`))
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', 'wrong-token'), { ok: true })
  assert.match(await fail(r.url), new RegExp(`拒绝了访问 .*：凭据「${r.credential}」里的令牌无效、已过期，或者没有授权这个仓库`))
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  assert.match(await fail(r.url.replace('/app', '/nope')), /找不到仓库 .*acme\/nope/)
  assert.deepEqual(r.store.list(), [])
  const e = await remote(undefined, { empty: true })
  assert.match((await e.sup.create({ repo: e.url, workflow: 'feature', request: '需求' }) as { error: string }).error, /acme\/app 还没有任何提交（空仓库）/)
  assert.deepEqual(e.store.list(), [])
  assert.equal(existsSync(mirrorDir(e.data, e.forge.parse(e.url)!)), false, '空仓库也不留镜像')
})

test('公开仓库不需要令牌；认不出的远程地址报出支持的写法；工作流不对时不访问网络', async () => {
  const r = await remote(undefined)
  const c = await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.ok(r.requests().every(q => q.auth === null), '没有令牌时不带认证头')
  assert.match((await r.sup.create({ repo: 'https://gitlab.com/a/b', workflow: 'feature', request: '需求' }) as { error: string }).error, /认不出仓库地址：https:\/\/gitlab\.com\/a\/b。目前支持 https:\/\/github\.com/)
  const before = r.requests().length
  assert.match((await r.sup.create({ repo: r.url, workflow: 'nope', request: '需求' }) as { error: string }).error, /平台上没有工作流「nope」/)
  assert.equal(r.requests().length, before)
})

test('凭据存在但读不出来（没有主密钥）：先匿名试；私有仓库失败时两个原因都报出来，公开仓库照样能用', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const noKey = new Credentials(join(r.data, 'eos.db'), undefined)
  cleanup.push(() => noKey.close())
  const sup = new Supervisor({ store: r.store, executor: new FakeExecutor(async () => '回复'), dataDir: r.data, credentials: noKey, forges: [r.forge] })
  const err = (await sup.create({ repo: r.url, workflow: 'feature', request: '需求' })) as { error: string }
  assert.match(err.error, new RegExp(`这是私有仓库或需要登录.*（凭据「${r.credential}」读不出来，所以没带令牌：没有设置主密钥`))
  assert.ok(r.requests().every(q => q.auth === null), '没带令牌')
  const pub = await remote(undefined)
  assert.deepEqual(pub.credentials.put(LOCAL_OWNER, pub.credential, 'token', TOKEN), { ok: true })
  const noKeyPub = new Credentials(join(pub.data, 'eos.db'), undefined)
  cleanup.push(() => noKeyPub.close())
  const supPub = new Supervisor({ store: pub.store, executor: new FakeExecutor(async () => '回复'), dataDir: pub.data, credentials: noKeyPub, forges: [pub.forge] })
  assert.equal((await supPub.create({ repo: pub.url, workflow: 'feature', request: '需求' })).ok, true)
})

test('失败时不留下这次新建的空镜像；地址大小写不同用同一个镜像', async () => {
  const r = await remote(TOKEN)
  await r.sup.create({ repo: r.url.replace('/app', '/nope'), workflow: 'feature', request: '需求' })
  assert.equal(existsSync(mirrorDir(r.data, r.forge.parse(r.url.replace('/app', '/nope'))!)), false)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const a = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '一' })) as { id: string }
  // GitHub 不分大小写（测试用的 git 服务分，所以只比较镜像路径）。
  assert.equal(mirrorDir(r.data, r.forge.parse(r.url.replace('/acme/app', '/ACME/App'))!), r.store.meta(a.id).repo)
})

test('不读宿主机的全局 git 配置：insteadOf 改不走地址，全局的认证头也带不上', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const global = join(r.dir, 'gitconfig')
  writeFileSync(global, `[url "http://127.0.0.1:1/"]\n\tinsteadOf = ${r.url.replace('/acme/app', '/')}\n[http]\n\textraheader = X-Leak: host-config\n`)
  const saved = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = global
  try {
    const c = await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })
    assert.equal(c.ok, true, JSON.stringify(c))
  } finally {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = saved
  }
})

test('访问远程时 Web 服务照常响应：create 是异步的，不卡住事件循环', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  const c = await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })
  clearInterval(timer)
  assert.equal(c.ok, true)
  assert.ok(ticks > 0, '访问远程期间计时器照常触发')
})

const SHIP = `name: ship
roles:
  developer:
    model: deepseek-flash
    write: worktree
    prompt: 按需求实现。
  reviewer:
    model: deepseek-flash
    prompt: 评审。
nodes:
  - id: build
    kind: agent
    role: developer
    task: 实现需求。
  - id: review
    kind: dialog
    role: reviewer
    with: build
    task: 评审。
  - id: deliver
    kind: dialog
    with: build
    task: 推送任务分支。
    maxRounds: 1
    checks:
      - { run: [git, --version] }
      - { platform: push }
`

/** 带推送的工作流：开发每次回复往 worktree 里写一个文件（平台随后提交）。 */
const shipper = (r: Awaited<ReturnType<typeof remote>>, credentials = r.credentials) => {
  assert.equal(r.sup.conventions.save({ kind: 'workflow', name: 'ship', content: SHIP, actor: 'test' }, Date.now()).ok, true)
  let n = 0
  const executor = new FakeExecutor(async ({ key }) => {
    if (key.endsWith('/review')) return PASS
    const id = key.split('/')[0]!
    writeFileSync(join(r.store.meta(id).worktree, `change-${++n}.txt`), `${n}\n`)
    return '改好了'
  })
  return new Supervisor({ store: r.store, executor, dataDir: r.data, credentials, forges: [r.forge], pollMs: 2 })
}

const remoteSha = (r: Awaited<ReturnType<typeof remote>>, branch: string): string =>
  execFileSync('git', ['--git-dir', join(r.dir, 'remote', 'acme', 'app.git'), 'rev-parse', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' }).trim()

test('平台动作 push：任务跑完后远程有同名分支，提交和任务分支一致，检查结果带分支链接；令牌不落盘', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const sup = shipper(r)
  const c = await sup.create({ repo: r.url, workflow: 'ship', request: '需求' })
  assert.equal(c.ok, true, JSON.stringify(c))
  const id = (c as { id: string }).id
  const started = sup.start(id)
  assert.ok(started.ok)
  const task = await started.done
  assert.equal(task.status, 'done', task.failure)
  const meta = r.store.meta(id)
  const local = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: meta.worktree, encoding: 'utf8' }).trim()
  assert.notEqual(local, r.first, '开发的改动提交了')
  assert.equal(remoteSha(r, meta.branch), local)
  const check = task.log.filter(e => e.type === 'check').at(-1) as Extract<(typeof task.log)[number], { type: 'check' }>
  const push = check.results.find(x => x.check.kind === 'platform')!
  assert.equal(push.passed, true)
  assert.deepEqual(push.links, [{ label: `分支 ${meta.branch}`, url: `${r.url}/tree/eos/${id}` }])
  assert.deepEqual(linksOf(task), push.links, '任务页显示这个链接')
  assert.match(push.detail, new RegExp(`已把分支 ${meta.branch}（${local.slice(0, 12)}）推到`))
  const header = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
  for (const f of filesUnder(r.data)) {
    const b = readFileSync(f)
    assert.ok(!b.includes(TOKEN) && !b.includes(header), f)
  }
})

test('远程的任务分支被别人推过：不强推，检查失败并说明原因；远程的提交保持原样', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const sup = shipper(r)
  const c = (await sup.create({ repo: r.url, workflow: 'ship', request: '需求' })) as { id: string }
  const meta = r.store.meta(c.id)
  // 别人先往同名分支推了一个提交。
  const other = r.commit('OTHER.md')
  execFileSync('git', ['--git-dir', join(r.dir, 'remote', 'acme', 'app.git'), 'update-ref', `refs/heads/${meta.branch}`, other])
  const started = sup.start(c.id, { wait: false })
  assert.ok(started.ok)
  const task = await started.done
  // agent 改不了：不交回开发，任务失败等人处理，重试时重新跑这一轮检查。
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', /平台替任务做的动作，agent 改不了/)
  assert.equal(task.log.filter(e => e.type === 'call' && e.node === 'deliver').length, 0, '没有交回开发')
  const results = task.log.filter(e => e.type === 'check').flatMap(e => (e as Extract<(typeof task.log)[number], { type: 'check' }>).results)
  const push = results.find(x => x.check.kind === 'platform' && !x.passed)!
  assert.match(push.detail, new RegExp(`分支 ${meta.branch} 已经有平台没有的提交（被别人推过或改过），平台不强推`))
  assert.equal(remoteSha(r, meta.branch), other, '远程没被覆盖')
})

test('平台动作：本机仓库的任务跳过推送并写明原因；前面的检查没通过时不推送', async () => {
  const { runChecks } = await import('../src/runner/checks.ts')
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.eos-push-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  let pushed = 0
  const platform = async (c: { kind: 'platform'; action: 'push' }) => { pushed++; return { check: c, passed: true, detail: '' } }
  const failed = await runChecks(dir, [{ kind: 'run', run: ['false'], timeoutSec: 5 }, { kind: 'platform', action: 'push' }], process.env, undefined, platform)
  assert.deepEqual(failed.map(x => [x.passed, x.detail]), [[false, failed[0]!.detail], [false, '前面的检查没有通过，这一步没有做']])
  assert.equal(pushed, 0)
  const ok = await runChecks(dir, [{ kind: 'run', run: ['true'], timeoutSec: 5 }, { kind: 'platform', action: 'push' }], process.env, undefined, platform)
  assert.deepEqual(ok.map(x => x.passed), [true, true])
  assert.equal(pushed, 1)
  // 本机仓库的任务：走完整个流程，推送这一步算通过并说明跳过。
  const r = await remote(undefined)
  const sup = shipper(r)
  const local = join(dir, 'local')
  mkdirSync(local)
  for (const a of [['init', '-q', '-b', 'main'], ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init']]) execFileSync('git', a, { cwd: local })
  const c = (await sup.create({ repo: local, workflow: 'ship', request: '需求' })) as { id: string }
  const task = await (sup.start(c.id) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(task.status, 'done', task.failure)
  const push = task.log.filter(e => e.type === 'check').flatMap(e => (e as Extract<(typeof task.log)[number], { type: 'check' }>).results).find(x => x.check.kind === 'platform')!
  assert.match(push.detail, /任务用的是本机仓库 .*，没有远程仓库，跳过推送/)
  assert.equal(r.requests().length, 0)
})

test('agent 自己提交了可写范围外的文件：不推送，列出这些文件', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const content = SHIP.replace('    write: worktree\n', '    write: worktree\n    writePaths: [src/**]\n').replace('name: ship', 'name: ship-src')
  assert.equal(r.sup.conventions.save({ kind: 'workflow', name: 'ship-src', content, actor: 'test' }, Date.now()).ok, true)
  // 开发在范围内写 src/a.js，又绕过平台自己提交了一个 CI 配置。
  const executor = new FakeExecutor(async ({ key }) => {
    if (key.endsWith('/review')) return PASS
    const wt = r.store.meta(key.split('/')[0]!).worktree
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'a.js'), 'x\n')
    mkdirSync(join(wt, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(wt, '.github', 'workflows', 'x.yml'), 'on: push\n')
    execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=a@x', 'add', '.github'], { cwd: wt })
    execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=a@x', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'sneak'], { cwd: wt })
    return '改好了'
  })
  const sup = new Supervisor({ store: r.store, executor, dataDir: r.data, credentials: r.credentials, forges: [r.forge], pollMs: 2 })
  const c = (await sup.create({ repo: r.url, workflow: 'ship-src', request: '需求' })) as { id: string }
  const task = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', /提交里有改动不在可写范围（src\/\*\*）内：\.github\/workflows\/x\.yml。这些提交不是平台做的，没有推送/)
  assert.throws(() => remoteSha(r, r.store.meta(c.id).branch), '远程没有这个分支')
})

test('平台动作失败后人工重试：重新跑这一轮检查，推送成功后任务完成', async () => {
  const r = await remote(TOKEN)
  const sup = shipper(r)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const c = (await sup.create({ repo: r.url, workflow: 'ship', request: '需求' })) as { id: string }
  // 推送前凭据被删了：推送被拒，任务失败。
  assert.equal(r.credentials.delete(LOCAL_OWNER, r.credential), true)
  const first = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(first.status, 'failed', first.failure)
  assert.match(first.failure ?? '', /这是私有仓库或需要登录/)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  assert.equal(r.store.dispatch(c.id, { kind: 'retry' }, Date.now(), 'web').accepted, true)
  const second = await (sup.start(c.id) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(second.status, 'done', second.failure)
  assert.equal(remoteSha(r, r.store.meta(c.id).branch), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.store.meta(c.id).worktree, encoding: 'utf8' }).trim())
})

test('任务中止后不做平台动作', async () => {
  const { runChecks } = await import('../src/runner/checks.ts')
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.eos-push-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const ac = new AbortController()
  ac.abort()
  let pushed = 0
  const out = await runChecks(dir, [{ kind: 'platform', action: 'push' }], process.env, ac.signal, async c => { pushed++; return { check: c, passed: true, detail: '' } })
  assert.deepEqual(out.map(x => x.detail), ['任务已中止，这一步没有做'])
  assert.equal(pushed, 0)
})

/** 带可写范围的推送工作流，开发每次回复时执行 sneak（在 worktree 里自己动 git）。 */
const scoped = async (sneak: (wt: string) => void) => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const content = SHIP.replace('    write: worktree\n', '    write: worktree\n    writePaths: [src/**]\n').replace('name: ship', 'name: ship-src')
  assert.equal(r.sup.conventions.save({ kind: 'workflow', name: 'ship-src', content, actor: 'test' }, Date.now()).ok, true)
  const executor = new FakeExecutor(async ({ key }) => {
    if (key.endsWith('/review')) return PASS
    const wt = r.store.meta(key.split('/')[0]!).worktree
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'a.js'), 'x\n')
    sneak(wt)
    return '改好了'
  })
  const sup = new Supervisor({ store: r.store, executor, dataDir: r.data, credentials: r.credentials, forges: [r.forge], pollMs: 2 })
  const c = (await sup.create({ repo: r.url, workflow: 'ship-src', request: '需求' })) as { id: string }
  const task = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  return { r, task, branch: r.store.meta(c.id).branch }
}
const g = (wt: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=a@x', '-c', 'commit.gpgsign=false', ...a], { cwd: wt, stdio: 'ignore' })

test('agent 先自己提交越界文件、再提交删掉它：最终的树里没有，但历史里有，照样不推送', async () => {
  const { r, task, branch } = await scoped(wt => {
    writeFileSync(join(wt, '.env'), 'SECRET=1\n')
    g(wt, 'add', '.env')
    g(wt, 'commit', '-q', '-m', 'add')
    g(wt, 'rm', '-q', '.env')
    g(wt, 'commit', '-q', '-m', 'remove')
  })
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', /提交里有改动不在可写范围（src\/\*\*）内：\.env/)
  assert.throws(() => remoteSha(r, branch))
})

test('agent 把任务分支移到别的历史上：基线不再是祖先，不推送', async () => {
  const { r, task, branch } = await scoped(wt => {
    const current = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim()
    g(wt, 'checkout', '-q', '--orphan', 'tmp')
    g(wt, 'rm', '-rq', '--cached', '.')
    mkdirSync(join(wt, 'src'), { recursive: true })
    writeFileSync(join(wt, 'src', 'b.js'), 'y\n')
    g(wt, 'add', 'src/b.js')
    g(wt, 'commit', '-q', '-m', 'unrelated')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim()
    g(wt, 'checkout', '-q', '-f', current)
    g(wt, 'reset', '-q', '--hard', sha)
  })
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', new RegExp(`任务分支 ${branch} 已经不在基线 .* 之后`))
  assert.throws(() => remoteSha(r, branch))
})
