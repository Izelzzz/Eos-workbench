import assert from 'node:assert/strict'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import { DatabaseSync } from 'node:sqlite'
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
after(() => {
  for (const f of cleanup) f()
})

const KEY = (parseMasterKey(Buffer.alloc(32, 4).toString('base64')) as { key: MasterKey }).key
const TOKEN = 'ghp_MirrorTestToken0123456789ABCDEF'

test('GitHub 地址：认 https、带 .git 或末尾 /、git@ 写法；认不出的返回 undefined', () => {
  const gh = githubForge()
  const want = {
    forge: 'github',
    host: 'github.com',
    owner: 'Izelzzz',
    name: 'eos-e2e-sandbox',
    cloneUrl: 'https://github.com/Izelzzz/eos-e2e-sandbox.git',
    webUrl: 'https://github.com/Izelzzz/eos-e2e-sandbox',
  }
  for (const s of [
    'https://github.com/Izelzzz/eos-e2e-sandbox',
    'github.com/Izelzzz/eos-e2e-sandbox',
    'https://github.com/Izelzzz/eos-e2e-sandbox.git',
    'https://github.com/Izelzzz/eos-e2e-sandbox/',
    ' git@github.com:Izelzzz/eos-e2e-sandbox.git ',
    'https://GitHub.com/Izelzzz/eos-e2e-sandbox',
  ])
    assert.deepEqual(gh.parse(s), want, s)
  for (const s of [
    'https://github.com/Izelzzz',
    'https://github.com/a/b/c',
    'https://gitlab.com/a/b',
    'http://github.com/a/b',
    'https://github.com/a/..',
    'https://github.com/-a/b',
    'https://github.com/a/b?x=1',
    '/srv/repo',
  ])
    assert.equal(gh.parse(s), undefined, s)
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
  assert.match(
    explain(repo, "fatal: could not read Username for 'https://github.com': terminal prompts disabled", { credential: 'github.com', hasToken: false }),
    /这是私有仓库或需要登录。在凭据页添加名字为「github\.com」/,
  )
  assert.match(
    explain(repo, "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", { credential: 'github.com', hasToken: true }),
    /找不到仓库 github\.com 上的 o\/r/,
  )
  assert.match(explain(repo, 'fatal: unable to access: Could not resolve host: github.com', { credential: 'github.com', hasToken: false }), /连不上 github\.com/)
  assert.equal(explain(repo, `fatal: weird ${TOKEN} thing`, { credential: 'github.com', hasToken: true, secrets: [TOKEN] }).includes(TOKEN), false)
  assert.match(explain(repo, "fatal: remote helper 'https' not found", { credential: 'github.com', hasToken: true }), /^访问 github\.com 上的 o\/r 失败：/, '本机 git 的问题不当成找不到仓库')
})

test('访问远程的环境：不继承宿主机的 GIT_CONFIG_PARAMETERS、GIT_SSL_NO_VERIFY，HOME 换成平台的目录，强制校验证书', () => {
  const repo = githubForge().parse('https://github.com/o/r')!
  const env = remoteEnv(repo, 'Authorization: Basic abc', '/srv/eos/git-home', {
    PATH: '/bin',
    HOME: '/root',
    GIT_CONFIG_PARAMETERS: "'url.x.insteadof'='https://github.com/'",
    GIT_SSL_NO_VERIFY: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.proxy',
    GIT_CONFIG_VALUE_0: 'http://proxy:3128',
  })
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined)
  assert.equal(env.GIT_SSL_NO_VERIFY, undefined)
  assert.equal(env.HOME, '/srv/eos/git-home')
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  const pairs = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]))
  assert.deepEqual(pairs, {
    'http.proxy': 'http://proxy:3128',
    'credential.helper': '',
    'http.sslVerify': 'true',
    'http.lowSpeedLimit': '1000',
    'http.lowSpeedTime': '60',
    'http.https://github.com/.extraheader': 'Authorization: Basic abc',
  })
})

/** 一个"远程"：bare 仓库放在 <root>/acme/app.git，由单独进程里的 git HTTP 服务提供，可以要求令牌。 */
const remote = async (token: string | undefined, o: { empty?: boolean; app?: { id: string; publicKeyPath: string; installed: string[]; ttlMs?: number } } = {}) => {
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
  const appEnv =
    o.app === undefined
      ? {}
      : {
          EOS_TEST_APP_ID: o.app.id,
          EOS_TEST_APP_KEY: o.app.publicKeyPath,
          EOS_TEST_APP_INSTALLED: o.app.installed.join(','),
          ...(o.app.ttlMs === undefined ? {} : { EOS_TEST_APP_TTL_MS: String(o.app.ttlMs) }),
        }
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests', 'git-server-main.ts'), root, token ?? '-', record], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ...appEnv },
  })
  cleanup.push(() => child.kill())
  const port = await new Promise<number>(r =>
    child.stdout!.on('data', (b: Buffer) => {
      const m = /port (\d+)/.exec(b.toString())
      if (m) r(Number(m[1]))
    }),
  )
  const forge = githubForge({ host: `127.0.0.1:${port}`, scheme: 'http' })
  const data = join(dir, 'data')
  const store = new Store(join(data, 'eos.db'))
  const credentials = new Credentials(join(data, 'eos.db'), KEY)
  cleanup.push(() => {
    credentials.close()
    store.close()
  })
  const sup = new Supervisor({ store, executor: new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : '回复')), dataDir: data, credentials, forges: [forge], pollMs: 2 })
  const url = `http://127.0.0.1:${port}/acme/app`
  const requests = () =>
    readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as { path: string; auth: string | null })
  return { dir, data, store, credentials, sup, url, first, commit, requests, credential: `127.0.0.1:${port}`, forge }
}

const filesUnder = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
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
  const a = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '一' })) as { id: string }
  const second = r.commit('NEXT.md')
  const b = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '二' })) as { id: string }
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
  assert.match(((await e.sup.create({ repo: e.url, workflow: 'feature', request: '需求' })) as { error: string }).error, /acme\/app 还没有任何提交（空仓库）/)
  assert.deepEqual(e.store.list(), [])
  assert.equal(existsSync(mirrorDir(e.data, e.forge.parse(e.url)!)), false, '空仓库也不留镜像')
})

test('公开仓库不需要令牌；认不出的远程地址报出支持的写法；工作流不对时不访问网络', async () => {
  const r = await remote(undefined)
  const c = await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })
  assert.equal(c.ok, true, JSON.stringify(c))
  assert.ok(
    r.requests().every(q => q.auth === null),
    '没有令牌时不带认证头',
  )
  assert.match(
    ((await r.sup.create({ repo: 'https://gitlab.com/a/b', workflow: 'feature', request: '需求' })) as { error: string }).error,
    /认不出仓库地址：https:\/\/gitlab\.com\/a\/b。目前支持 https:\/\/github\.com/,
  )
  const before = r.requests().length
  assert.match(((await r.sup.create({ repo: r.url, workflow: 'nope', request: '需求' })) as { error: string }).error, /平台上没有工作流「nope」/)
  assert.equal(r.requests().length, before)
})

test('凭据存在但读不出来（没有主密钥）：先匿名试；私有仓库失败时两个原因都报出来，公开仓库照样能用', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const noKey = new Credentials(join(r.data, 'eos.db'), undefined)
  cleanup.push(() => noKey.close())
  const sup = new Supervisor({ store: r.store, executor: new FakeExecutor(async () => '回复'), dataDir: r.data, credentials: noKey, forges: [r.forge] })
  const err = (await sup.create({ repo: r.url, workflow: 'feature', request: '需求' })) as { error: string }
  assert.match(err.error, new RegExp(`这是私有仓库或需要登录.*（没用上的凭据：没有设置主密钥`))
  assert.ok(
    r.requests().every(q => q.auth === null),
    '没带令牌',
  )
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
  assert.deepEqual(push.links, [{ label: `分支 ${meta.branch}`, url: `${r.url}/tree/eos/${id}`, kind: 'branch' }])
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
  const platform = async (c: { kind: 'platform'; action: 'push' | 'pull-request' }) => {
    pushed++
    return { check: c, passed: true, detail: '' }
  }
  const failed = await runChecks(
    dir,
    [
      { kind: 'run', run: ['false'], timeoutSec: 5 },
      { kind: 'platform', action: 'push' },
    ],
    process.env,
    undefined,
    platform,
  )
  assert.deepEqual(
    failed.map(x => [x.passed, x.detail]),
    [
      [false, failed[0]!.detail],
      [false, '前面的检查没有通过，这一步没有做'],
    ],
  )
  assert.equal(pushed, 0)
  const ok = await runChecks(
    dir,
    [
      { kind: 'run', run: ['true'], timeoutSec: 5 },
      { kind: 'platform', action: 'push' },
    ],
    process.env,
    undefined,
    platform,
  )
  assert.deepEqual(
    ok.map(x => x.passed),
    [true, true],
  )
  assert.equal(pushed, 1)
  // 本机仓库的任务：走完整个流程，推送这一步算通过并说明跳过。
  const r = await remote(undefined)
  const sup = shipper(r)
  const local = join(dir, 'local')
  mkdirSync(local)
  for (const a of [
    ['init', '-q', '-b', 'main'],
    ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'],
  ])
    execFileSync('git', a, { cwd: local })
  const c = (await sup.create({ repo: local, workflow: 'ship', request: '需求' })) as { id: string }
  const task = await (sup.start(c.id) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(task.status, 'done', task.failure)
  const push = task.log
    .filter(e => e.type === 'check')
    .flatMap(e => (e as Extract<(typeof task.log)[number], { type: 'check' }>).results)
    .find(x => x.check.kind === 'platform')!
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
  const out = await runChecks(dir, [{ kind: 'platform', action: 'push' }], process.env, ac.signal, async c => {
    pushed++
    return { check: c, passed: true, detail: '' }
  })
  assert.deepEqual(
    out.map(x => x.detail),
    ['任务已中止，这一步没有做'],
  )
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

const PR_FLOW = SHIP.replace('name: ship', 'name: ship-pr').replace('      - { platform: push }', '      - { platform: pull-request }')

/** 跑一个开 PR 的任务：write 为 false 时开发不改任何文件。 */
const runPr = async (r: Awaited<ReturnType<typeof remote>>, o: { write?: boolean; request?: string; sup?: Supervisor } = {}) => {
  const saved = r.sup.conventions.save({ kind: 'workflow', name: 'ship-pr', content: PR_FLOW, actor: 'test' }, Date.now())
  assert.ok(saved.ok || JSON.stringify(saved).includes('完全一样'), JSON.stringify(saved))
  const executor = new FakeExecutor(async ({ key }) => {
    if (key.endsWith('/review')) return PASS
    if (o.write !== false) writeFileSync(join(r.store.meta(key.split('/')[0]!).worktree, 'feature.txt'), 'new\n')
    return '改好了'
  })
  const sup = o.sup ?? new Supervisor({ store: r.store, executor, dataDir: r.data, credentials: r.credentials, forges: [r.forge], pollMs: 2 })
  const c = (await sup.create({ repo: r.url, workflow: 'ship-pr', request: o.request ?? '给首页加一个按钮\n点了以后跳到设置页' })) as { id: string }
  const task = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  const result = task.log
    .flatMap(e => (e.type === 'check' ? e.results : []))
    .filter(x => x.check.kind === 'platform')
    .at(-1)!
  return { task, result, meta: r.store.meta(c.id), id: c.id }
}
const apiCalls = (r: Awaited<ReturnType<typeof remote>>) =>
  r.requests().filter(q => q.path.startsWith('/api/')) as { path: string; method: string; auth: string | null; body?: Record<string, string> }[]

test('平台动作 pull-request：推送后向默认分支开 PR，标题是需求第一行，检查结果带分支和 PR 两个链接', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const { task, result, meta, id } = await runPr(r)
  assert.equal(task.status, 'done', task.failure)
  assert.equal(meta.baseBranch, 'main')
  assert.equal(result.passed, true)
  assert.match(result.detail, /已开 PR #1：http:\/\/127\.0\.0\.1:\d+\/acme\/app\/pull\/1/)
  assert.deepEqual(
    result.links?.map(l => [l.kind, l.label]),
    [
      ['branch', `分支 ${meta.branch}`],
      ['pull-request', 'PR #1'],
    ],
  )
  assert.deepEqual(
    linksOf(task).map(l => l.kind),
    ['branch', 'pull-request'],
  )
  const posts = apiCalls(r).filter(q => q.method === 'POST')
  assert.equal(posts.length, 1)
  assert.deepEqual({ ...posts[0]!.body, body: undefined }, { title: '给首页加一个按钮', head: meta.branch, base: 'main', body: undefined })
  assert.match(posts[0]!.body!.body!, new RegExp(`点了以后跳到设置页[\\s\\S]*由 Eos 平台开的 PR：任务 ${id}，分支 ${meta.branch}`))
  assert.ok(apiCalls(r).every(q => q.auth === `Bearer ${TOKEN}`))
  assert.equal(remoteSha(r, meta.branch), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: meta.worktree, encoding: 'utf8' }).trim())
})

test('分支已经有打开的 PR（例如崩溃后重跑、人工先开了）：复用它，不开第二个', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const first = await runPr(r)
  assert.equal(first.task.status, 'done')
  // 同一个分支再开一次（重跑交付时平台就是这样调用的）。
  const again = await r.forge.openPullRequest(r.forge.parse(r.url)!, TOKEN, { head: first.meta.branch, base: 'main', sha: 'x'.repeat(40), title: 'x', body: 'y' })
  assert.deepEqual(again, { number: 1, url: first.result.links![1]!.url, reused: true })
  assert.equal(apiCalls(r).filter(q => q.method === 'POST').length, 1, '只开过一个 PR')
})

test('修正（路线图 5c）：已完成、开过 PR 的任务提交修正，改完推到同一个分支、复用同一个 PR，不开第二个', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const saved = r.sup.conventions.save({ kind: 'workflow', name: 'ship-pr', content: PR_FLOW, actor: 'test' }, Date.now())
  assert.ok(saved.ok || JSON.stringify(saved).includes('完全一样'), JSON.stringify(saved))
  // 开发第一次写 feature.txt；修正时（提示词里有「改正或补充」）再写 fix.txt。
  const executor = new FakeExecutor(async ({ key, prompt }) => {
    if (key.endsWith('/review')) return PASS
    const wt = r.store.meta(key.split('/')[0]!).worktree
    if (prompt.includes('改正或补充')) writeFileSync(join(wt, 'fix.txt'), 'fix\n')
    else writeFileSync(join(wt, 'feature.txt'), 'new\n')
    return '改好了'
  })
  const sup = new Supervisor({ store: r.store, executor, dataDir: r.data, credentials: r.credentials, forges: [r.forge], pollMs: 2 })
  const c = (await sup.create({ repo: r.url, workflow: 'ship-pr', request: '给首页加一个按钮' })) as { id: string }
  const first = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(first.status, 'done', first.failure)
  const meta = r.store.meta(c.id)
  const before = remoteSha(r, meta.branch)
  const posts = () => apiCalls(r).filter(q => q.method === 'POST').length
  assert.equal(posts(), 1)
  assert.ok(r.store.dispatch(c.id, { kind: 'corrected', node: 'build' as never, text: '补一个 fix.txt' }, Date.now(), 'cli').accepted)
  const task = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(task.status, 'done', task.failure)
  assert.ok(task.log.some(e => e.type === 'note' && e.text === '第 1 次修正完成'))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: meta.worktree, encoding: 'utf8' }).trim()
  assert.notEqual(head, before, '修正有新的提交')
  assert.equal(remoteSha(r, meta.branch), head, '推到了同一个分支')
  assert.equal(execFileSync('git', ['merge-base', '--is-ancestor', before, head], { cwd: meta.worktree }).length, 0, '在原来的提交之后接着提交（快进，不强推）')
  assert.equal(posts(), 1, '没有开第二个 PR')
  const last = task.log
    .flatMap(e => (e.type === 'check' ? e.results : []))
    .filter(x => x.check.kind === 'platform')
    .at(-1)!
  assert.equal(last.passed, true)
  assert.deepEqual(
    last.links?.find(l => l.kind === 'pull-request')?.url,
    first.log
      .flatMap(e => (e.type === 'check' ? e.results : []))
      .filter(x => x.check.kind === 'platform')
      .at(-1)!
      .links?.find(l => l.kind === 'pull-request')?.url,
    '修正后的检查结果链接到同一个 PR',
  )
})

test('任务没有改动：推送了，但不开 PR，算通过并写明原因；本机仓库的任务跳过推送和开 PR', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const { task, result } = await runPr(r, { write: false })
  assert.equal(task.status, 'done', task.failure)
  assert.match(result.detail, /任务分支和 main 没有差别，没有开 PR/)
  assert.deepEqual(
    result.links?.map(l => l.kind),
    ['branch'],
  )
})

test('开 PR 时令牌不对、没有令牌：报中文原因，不含令牌', async () => {
  const r = await remote(TOKEN)
  const repo = r.forge.parse(r.url)!
  await assert.rejects(r.forge.openPullRequest(repo, 'wrong-token', { head: 'x', base: 'main', sha: 'x'.repeat(40), title: 't', body: 'b' }), (e: Error) => {
    assert.match(e.message, new RegExp(`${r.credential} 拒绝了查已有的 PR 的请求：凭据「${r.credential}」里的令牌无效或已过期`))
    assert.ok(!e.message.includes('wrong-token'))
    return true
  })
  await assert.rejects(r.forge.openPullRequest(repo, undefined, { head: 'x', base: 'main', sha: 'x'.repeat(40), title: 't', body: 'b' }), /没有带令牌，开 PR 需要令牌。在凭据页添加名字为「.*」/)
})

test('standard 工作流的交付阶段是平台开 PR；它能通过解析', async () => {
  const r = await remote(undefined)
  const resolved = r.sup.conventions.resolve('standard')
  assert.ok(resolved.ok, JSON.stringify(resolved))
  const deliver = resolved.workflow.nodes.find(n => n.id === 'deliver')!
  assert.deepEqual(deliver.checks, [{ kind: 'platform', action: 'pull-request' }])
})

test('分支已经有打开的 PR、要开的目标分支不同：也复用它；旧任务没记下默认分支时现问远程', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const repo = r.forge.parse(r.url)!
  // 任务开出的 PR 指向 main；再要求开一个指向 develop 的：这个分支已经有打开的 PR，复用它。
  const first = await runPr(r)
  const reused = await r.forge.openPullRequest(repo, TOKEN, { head: first.meta.branch, base: 'develop', sha: 'x'.repeat(40), title: 'x', body: 'y' })
  assert.deepEqual(reused, { number: 1, url: first.result.links![1]!.url, reused: true })
  // 旧任务：meta 里没有 baseBranch（直接改数据库模拟旧版本建的任务）。
  const sup = new Supervisor({
    store: r.store,
    executor: new FakeExecutor(async ({ key }) => {
      if (key.endsWith('/review')) return PASS
      writeFileSync(join(r.store.meta(key.split('/')[0]!).worktree, 'old.txt'), 'old\n')
      return '改好了'
    }),
    dataDir: r.data,
    credentials: r.credentials,
    forges: [r.forge],
    pollMs: 2,
  })
  const c = (await sup.create({ repo: r.url, workflow: 'ship-pr', request: '旧任务' })) as { id: string }
  const meta = r.store.meta(c.id)
  const { baseBranch: _dropped, ...old } = meta
  const db = new DatabaseSync(join(r.data, 'eos.db'))
  db.prepare('UPDATE tasks SET meta = ? WHERE id = ?').run(JSON.stringify(old), c.id)
  db.close()
  assert.equal(r.store.meta(c.id).baseBranch, undefined)
  const task = await (sup.start(c.id, { wait: false }) as { done: Promise<import('../src/engine/types.ts').Task> }).done
  assert.equal(task.status, 'done', task.failure)
  const posts = apiCalls(r).filter(q => q.method === 'POST')
  assert.equal(posts.at(-1)!.body!.base, 'main', '现问到的默认分支')
})

test('GitHub 的 422 只给 field 和 code 时，报错里写出来', async () => {
  const r = await remote(TOKEN)
  await assert.rejects(
    r.forge.openPullRequest(r.forge.parse(r.url)!, TOKEN, { head: 'no-such-branch', base: 'main', sha: 'x'.repeat(40), title: 't', body: 'b' }),
    /开 PR 失败（HTTP 422）：Validation Failed；head invalid/,
  )
})

const control = (r: Awaited<ReturnType<typeof remote>>, what: string) => fetch(`${r.url.replace('/acme/app', '')}/__control/${what}`)

test('推送成功、开 PR 失败：任务失败，原因写明已推送和开 PR 失败的原因，保留分支链接，不含令牌', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  await control(r, 'fail-post?status=403')
  const { task, result, meta } = await runPr(r)
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', new RegExp(`已把分支 ${meta.branch}（[0-9a-f]{12}）推到 .*，但开 PR 失败：.* 不允许在 .*acme/app 开 PR：令牌没有 Pull requests 的写权限`))
  assert.deepEqual(
    result.links?.map(l => l.kind),
    ['branch'],
  )
  assert.ok(!JSON.stringify(task).includes(TOKEN))
  assert.equal(remoteSha(r, meta.branch), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: meta.worktree, encoding: 'utf8' }).trim(), '推送已经做了')
})

test('查和开之间别人刚开了一个（422 already exists）：再查一次，复用它', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const first = await runPr(r)
  await control(r, 'hide-next-list')
  const again = await r.forge.openPullRequest(r.forge.parse(r.url)!, TOKEN, { head: first.meta.branch, base: 'main', sha: 'x'.repeat(40), title: 'x', body: 'y' })
  assert.deepEqual(again, { number: 1, url: first.result.links![1]!.url, reused: true })
  const posts = apiCalls(r).filter(q => q.method === 'POST')
  assert.equal(posts.length, 2, '第二次 POST 收到 422 已存在')
})

test('之前的 PR 已经合并：再开时如实报告已合并，不当成没有差别；PR 被关掉（没合并）时开一个新的', async () => {
  const r = await remote(TOKEN)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const first = await runPr(r)
  const repo = r.forge.parse(r.url)!
  const sha = remoteSha(r, first.meta.branch)
  await control(r, 'merge?n=1')
  assert.deepEqual(await r.forge.openPullRequest(repo, TOKEN, { head: first.meta.branch, base: 'main', sha, title: 'x', body: 'y' }), { merged: { number: 1, url: first.result.links![1]!.url } })
  // 另一个任务的 PR 被关掉、没合并：再开时开新的。
  const second = await runPr(r, { request: '第二个任务' })
  const prNumber = Number(/#(\d+)/.exec(second.result.links![1]!.label)![1])
  await control(r, `close?n=${prNumber}`)
  const reopened = await r.forge.openPullRequest(repo, TOKEN, { head: second.meta.branch, base: 'main', sha: remoteSha(r, second.meta.branch), title: 'x', body: 'y' })
  assert.ok('number' in reopened && reopened.number === prNumber + 1 && reopened.reused === false, JSON.stringify(reopened))
})

test('GitHub API 连不上：报中文原因和底层原因', async () => {
  // 找一个没人监听的端口。
  const { createServer } = await import('node:net')
  const probe = createServer()
  await new Promise<void>(res => probe.listen(0, '127.0.0.1', res))
  const port = (probe.address() as import('node:net').AddressInfo).port
  await new Promise(res => probe.close(res))
  const forge = githubForge({ host: `127.0.0.1:${port}`, scheme: 'http' })
  await assert.rejects(
    forge.openPullRequest(forge.parse(`http://127.0.0.1:${port}/a/b`)!, TOKEN, { head: 'h', base: 'main', sha: 'x'.repeat(40), title: 't', body: 'b' }),
    new RegExp(`访问 127\\.0\\.0\\.1:${port} 失败：fetch failed：ECONNREFUSED`),
  )
})

/** 一个 GitHub App：现场生成的 RSA 密钥对，公钥写到文件交给测试服务。 */
const makeApp = (id = '424242') => {
  const { generateKeyPairSync } = require('node:crypto') as typeof import('node:crypto')
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const dir = mkdtempSync(join(ROOT, 'node_modules', '.eos-app-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const publicKeyPath = join(dir, 'app.pub.pem')
  writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }))
  return { id, publicKeyPath, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
}
const appCred = (r: Awaited<ReturnType<typeof remote>>, app: ReturnType<typeof makeApp>, extra: Record<string, unknown> = {}) =>
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, `github-app.${r.credential}`, 'github-app', JSON.stringify({ appId: app.id, privateKey: app.privateKey, ...extra })), { ok: true })
const mints = (r: Awaited<ReturnType<typeof remote>>) => r.requests().filter(q => /access_tokens$/.test(q.path)) as { path: string; body?: { repositories?: string[] } }[]

test('GitHub App：只配 App、不配令牌，克隆、推送、开 PR 都用换来的安装令牌；令牌只授权这个仓库，不落盘', async () => {
  const app = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/app', 'acme/other'] } })
  appCred(r, app)
  const { task, result } = await runPr(r)
  assert.equal(task.status, 'done', task.failure)
  assert.match(result.detail, /已开 PR #1/)
  // 只换了一次令牌，只授权 app 这一个仓库（App 也装在 acme/other 上）。
  assert.deepEqual(
    mints(r).map(m => m.body),
    [{ repositories: ['app'] }],
  )
  const tokens = new Set(
    r.requests().flatMap(q => {
      const a = q.auth ?? ''
      if (a.startsWith('Basic ')) return [Buffer.from(a.slice(6), 'base64').toString('utf8').split(':')[1]!]
      if (a.startsWith('Bearer ghs_')) return [a.slice(7)]
      return []
    }),
  )
  assert.equal(tokens.size, 1, `git 和 PR 接口用的是同一个安装令牌：${[...tokens].join(',')}`)
  const ghs = [...tokens][0]!
  assert.match(ghs, /^ghs_/)
  for (const f of filesUnder(r.data)) {
    const b = readFileSync(f)
    assert.ok(!b.includes(ghs) && !b.includes(Buffer.from(`x-access-token:${ghs}`).toString('base64')), f)
  }
})

test('GitHub App：令牌在有效期内只换一次；离到期不到 5 分钟时换新的', async () => {
  const app = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/app'] } })
  appCred(r, app)
  for (const request of ['一', '二']) assert.equal((await r.sup.create({ repo: r.url, workflow: 'feature', request })).ok, true)
  assert.equal(mints(r).length, 1, '1 小时有效：复用')
  // 有效期只有 4 分钟的令牌：一换来就离到期不到 5 分钟，下次用之前换新的。
  const short = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/app'], ttlMs: 4 * 60 * 1000 } })
  appCred(short, app)
  for (const request of ['一', '二']) assert.equal((await short.sup.create({ repo: short.url, workflow: 'feature', request })).ok, true)
  assert.equal(mints(short).length, 2, '快到期：换新的')
})

test('GitHub App 没装到这个仓库：退回个人访问令牌；没有令牌时报出 App 没装和安装地址', async () => {
  const app = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/other'] } })
  appCred(r, app, { slug: 'eos-test' })
  const failed = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })) as { ok: boolean; error: string }
  assert.equal(failed.ok, false)
  assert.match(
    failed.error,
    /这是私有仓库或需要登录.*（没用上的凭据：凭据「github-app\..*」的 GitHub App 没有安装到 acme\/app：到 https:\/\/.*\/apps\/eos-test\/installations\/new 把它安装到这个仓库）/,
  )
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const ok = await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(mints(r).length, 0)
})

test('GitHub App 的私钥不对、凭据格式不对：报中文原因', async () => {
  const app = makeApp()
  const other = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/app'] } })
  // 用别的私钥签：GitHub 不认这个 App。
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, `github-app.${r.credential}`, 'github-app', JSON.stringify({ appId: app.id, privateKey: other.privateKey })), { ok: true })
  // 同时也配了个人令牌：App 出错时不悄悄换成个人令牌的身份。
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const before = r.requests().length
  const wrongKey = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })) as { error: string }
  assert.match(wrongKey.error, /^127\.0\.0\.1:\d+ 不认凭据「github-app\..*」的 App：App id 或私钥不对/)
  assert.doesNotMatch(wrongKey.error, /添加名字为/, '不叫人去加令牌')
  assert.ok(
    r
      .requests()
      .slice(before)
      .every(q => !(q.auth ?? '').includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'))),
    '没有用个人令牌',
  )
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, `github-app.${r.credential}`, 'github-app', JSON.stringify({ appid: 1, privateKey: app.privateKey })), { ok: true })
  const badJson = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '需求' })) as { error: string }
  assert.match(badJson.error, /不是有效的 GitHub App 凭据：appId/)
  assert.ok(!badJson.error.includes(app.privateKey.slice(40, 80)))
})

test('GitHub App 没装到这个仓库、用了个人令牌：别的原因失败时，报错里不附"App 没装"', async () => {
  const app = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/other'] } })
  appCred(r, app)
  assert.deepEqual(r.credentials.put(LOCAL_OWNER, r.credential, 'token', TOKEN), { ok: true })
  const c = (await r.sup.create({ repo: r.url.replace('/app', '/nope'), workflow: 'feature', request: '需求' })) as { error: string }
  assert.match(c.error, /找不到仓库/)
  assert.doesNotMatch(c.error, /没有安装/)
})

test('用 GitHub App 开 PR 被拒（403）：报错指向 App 的 Pull requests 权限', async () => {
  const app = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/app'] } })
  appCred(r, app)
  await control(r, 'fail-post?status=403')
  const { task } = await runPr(r)
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', /开 PR 失败：.*凭据「github-app\..*」的 GitHub App 没有 Pull requests 的写权限/)
})

test('App 令牌被吊销（例如 App 卸载重装）：用它访问失败后作废缓存，下次重新换，不用等令牌过期', async () => {
  const app = makeApp()
  const r = await remote(TOKEN, { app: { id: app.id, publicKeyPath: app.publicKeyPath, installed: ['acme/app'] } })
  appCred(r, app)
  assert.equal((await r.sup.create({ repo: r.url, workflow: 'feature', request: '一' })).ok, true)
  await control(r, 'revoke')
  const failed = (await r.sup.create({ repo: r.url, workflow: 'feature', request: '二' })) as { ok: boolean; error: string }
  assert.equal(failed.ok, false)
  assert.match(failed.error, /GitHub App 换来的令牌没有权限.*改好后重试会重新换令牌/)
  assert.equal(mints(r).length, 1)
  assert.equal((await r.sup.create({ repo: r.url, workflow: 'feature', request: '三' })).ok, true, '重试时换了新令牌')
  assert.equal(mints(r).length, 2)
})

/** 在 remote() 上起平台的 Web 服务（和 remote 用同一个 Supervisor 和凭据存储），浏览器从 127.0.0.1 访问。 */
const webOn = async (r: Awaited<ReturnType<typeof remote>>, credentials: Credentials = r.credentials) => {
  const { createWebServer } = await import('../src/web/server.ts')
  const server = createWebServer({ store: r.store, supervisor: r.sup, replay: { traceOf: async () => [] }, staticDir: join(r.dir, 'static'), credentials })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  cleanup.push(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { base, post }
}

/** 浏览器做的事：把表单提交到托管平台，跟着它跳回平台的回调，返回平台最后跳到的页面地址（只跟一次托管平台、一次平台的跳转）。 */
const submitManifest = async (action: string, fields: Record<string, string>): Promise<{ callback: string; page: string }> => {
  const atForge = await fetch(action, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' })
  assert.equal(atForge.status, 302)
  const callback = atForge.headers.get('location')!
  const atPlatform = await fetch(callback, { redirect: 'manual' })
  assert.equal(atPlatform.status, 303)
  return { callback, page: atPlatform.headers.get('location')! }
}

test('清单流程注册 GitHub App：表单提交到 GitHub，跳回回调后存下 App 凭据（不存 webhook secret）；装到仓库后克隆用的是 App 的令牌', async () => {
  const r = await remote(TOKEN)
  const web = await webOn(r)
  const name = `github-app.${r.credential}`
  const before = (await (await fetch(`${web.base}/api/forge-apps`)).json()) as import('../src/web/types.ts').ForgeAppsResponse
  assert.deepEqual(before, { usable: true, callbackUrl: `${web.base}/api/forge-apps/callback`, apps: [{ name, host: r.credential, appNameMax: 34, user: { unavailable: '先注册 App' } }] })

  // 写接口照样只接受同源请求。
  assert.equal(
    (await fetch(`${web.base}/api/forge-apps/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, appName: 'eos-test' }) })).status,
    403,
  )
  const started = (await (await web.post('/api/forge-apps/register', { name, appName: 'Eos-Test' })).json()) as { ok: true; action: string; fields: Record<string, string> }
  assert.equal(started.ok, true)
  const action = new URL(started.action)
  assert.equal(`${action.origin}${action.pathname}`, `http://${r.credential}/settings/apps/new`)
  const state = action.searchParams.get('state')!
  assert.ok(state.length >= 40, 'state 是足够长的随机串')
  const manifest = JSON.parse(started.fields.manifest!)
  assert.deepEqual(manifest, {
    name: 'Eos-Test',
    url: web.base,
    redirect_url: `${web.base}/api/forge-apps/callback`,
    callback_urls: [`${web.base}/api/forge-apps/user-callback`],
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    default_events: [],
  })

  const done = await submitManifest(started.action, started.fields)
  assert.equal(done.page, `/#/forges?registered=${encodeURIComponent(name)}&app=Eos-Test`)
  const saved = r.credentials.get(LOCAL_OWNER, name)
  assert.equal(saved.kind, 'ok')
  const value = JSON.parse((saved as { value: string }).value)
  assert.deepEqual(
    Object.keys(value).sort(),
    ['appId', 'clientId', 'clientSecret', 'htmlUrl', 'privateKey', 'slug', 'userCallbackUrl'],
    '只存 App id、私钥、短名、页面地址，以及用户授权用的 client id 和 secret（不存 webhook secret）',
  )
  assert.equal(value.slug, 'eos-test')
  assert.match(value.privateKey, /BEGIN RSA PRIVATE KEY/)
  assert.equal(r.credentials.list(LOCAL_OWNER).find(i => i.name === name)?.kind, 'github-app')
  const after = (await (await fetch(`${web.base}/api/forge-apps`)).json()) as import('../src/web/types.ts').ForgeAppsResponse
  assert.equal(after.apps[0]!.registered?.installUrl, `http://${r.credential}/apps/eos-test/installations/new`)

  // 同一个回调地址再来一次（例如浏览器后退、别人拿到了这个地址）：state 只能用一次。
  const replay = await fetch(done.callback, { redirect: 'manual' })
  assert.match(new URLSearchParams(replay.headers.get('location')!.split('?')[1]).get('error')!, /已经过期、已经用过/)
  // 已经注册过：不悄悄换掉。
  const again = await web.post('/api/forge-apps/register', { name, appName: 'eos-2' })
  assert.equal(again.status, 409)
  assert.match((await again.json()).error, /先在凭据页删掉/)

  // App 装到仓库后，平台不用个人令牌（凭据存储里没有）就能克隆：用的是这个 App 换来的安装令牌。
  await fetch(`http://${r.credential}/__control/install?repo=acme/app`)
  const created = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'x' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.ok(
    r.requests().some(q => q.path === '/api/v3/app/installations/1000/access_tokens'),
    '换了安装令牌',
  )
})

test('清单流程的回调：不是本平台发起的 state、没带 code、code 换不到凭据，都不存任何东西，回到页面说明原因', async () => {
  const r = await remote(TOKEN)
  const web = await webOn(r)
  const name = `github-app.${r.credential}`
  /** 回调跳回页面时带的错误说明。 */
  const page = async (url: string) => new URLSearchParams((await fetch(url, { redirect: 'manual' })).headers.get('location')!.split('?')[1]).get('error') ?? ''
  assert.match(await page(`${web.base}/api/forge-apps/callback?code=abc&state=forged`), /这次注册不是从本页面发起的.*那边已经建好了一个 App：到托管平台的 App 设置里删掉它/)
  assert.doesNotMatch(await page(`${web.base}/api/forge-apps/callback?state=forged`), /删掉它/, '没带 code：托管平台上没有建 App，不提示删')

  const start = async () => new URL(((await (await web.post('/api/forge-apps/register', { name, appName: 'eos-x' })).json()) as { action: string }).action).searchParams.get('state')!
  assert.match(await page(`${web.base}/api/forge-apps/callback?state=${await start()}`), /没有带回 code/)
  assert.match(await page(`${web.base}/api/forge-apps/callback?code=unknown&state=${await start()}`), /不认这次注册返回的 code/)
  assert.deepEqual(r.credentials.list(LOCAL_OWNER), [])

  // 发起注册之后、跳回之前，别处已经存了这个名字的凭据：不覆盖它。
  const started = (await (await web.post('/api/forge-apps/register', { name, appName: 'eos-race' })).json()) as { action: string; fields: Record<string, string> }
  r.credentials.put(LOCAL_OWNER, name, 'github-app', '{"appId":1,"privateKey":"old PRIVATE KEY"}')
  const raced = await submitManifest(started.action, started.fields)
  assert.match(new URLSearchParams(raced.page.split('?')[1]).get('error')!, /注册期间已经有了凭据.*没有覆盖它/)
  assert.equal((r.credentials.get(LOCAL_OWNER, name) as { value: string }).value, '{"appId":1,"privateKey":"old PRIVATE KEY"}')
  r.credentials.delete(LOCAL_OWNER, name)

  // 输入的检查：名字太长、组织名不对、没有这个托管平台。
  assert.equal((await web.post('/api/forge-apps/register', { name, appName: 'x'.repeat(35) })).status, 400)
  assert.equal((await web.post('/api/forge-apps/register', { name, appName: '😀'.repeat(34) })).status, 200, '按字符数算：34 个 emoji 不超长')
  assert.equal((await web.post('/api/forge-apps/register', { name, appName: 'eos', org: 'bad/org' })).status, 400)
  assert.equal((await web.post('/api/forge-apps/register', { name: 'github-app.gitlab.com', appName: 'eos' })).status, 400)
  // 注册在组织下：表单提交到组织的页面。
  const org = (await (await web.post('/api/forge-apps/register', { name, appName: 'eos', org: 'acme' })).json()) as { action: string }
  assert.equal(new URL(org.action).pathname, '/organizations/acme/settings/apps/new')
})

test('没有主密钥时不能发起注册：注册完存不了私钥，GitHub 上会留下一个用不上的 App', async () => {
  const r = await remote(TOKEN)
  const web = await webOn(r, new Credentials(join(r.data, 'eos.db'), undefined))
  const res = await web.post('/api/forge-apps/register', { name: `github-app.${r.credential}`, appName: 'eos' })
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /没有主密钥/)
})

/** 注册一个 App（模拟 GitHub）并装到 acme/app，返回 Web 服务；OAuth 的测试都从这里开始。 */
const registeredApp = async (o: { userTtlS?: number } = {}) => {
  if (o.userTtlS !== undefined) process.env.EOS_TEST_USER_TTL_S = String(o.userTtlS)
  const r = await remote(TOKEN)
  delete process.env.EOS_TEST_USER_TTL_S
  const web = await webOn(r)
  const name = `github-app.${r.credential}`
  const started = (await (await web.post('/api/forge-apps/register', { name, appName: 'eos-oauth' })).json()) as { action: string; fields: Record<string, string> }
  await submitManifest(started.action, started.fields)
  await fetch(`http://${r.credential}/__control/install?repo=acme/app`)
  /** 浏览器做的事：去 GitHub 授权页（模拟的直接跳回），跟着跳回平台的回调，返回平台最后跳到的页面地址。 */
  const authorize = async (): Promise<string> => {
    const res = await web.post('/api/forge-apps/authorize', { name })
    const body = (await res.json()) as { ok: boolean; url?: string; error?: string }
    assert.equal(body.ok, true, JSON.stringify(body))
    const atGitHub = await fetch(body.url!, { redirect: 'manual' })
    assert.equal(atGitHub.status, 302)
    const atPlatform = await fetch(atGitHub.headers.get('location')!, { redirect: 'manual' })
    assert.equal(atPlatform.status, 303)
    return atPlatform.headers.get('location')!
  }
  const user = `github-user.${r.credential}`
  /** git 请求里用过的令牌（从 Basic 认证头里解出来）。 */
  const gitTokens = () =>
    r
      .requests()
      .filter(q => q.path.includes('.git/') && q.auth !== null)
      .map(
        q =>
          Buffer.from(q.auth!.replace(/^Basic /, ''), 'base64')
            .toString('utf8')
            .split(':')[1]!,
      )
  return { ...r, web, name, user, authorize, gitTokens }
}

test('用户授权（OAuth）：授权后存下授权人和令牌；克隆用的是授权人的令牌，不是 App 的安装令牌', async () => {
  const r = await registeredApp()
  const before = (await (await fetch(`${r.web.base}/api/forge-apps`)).json()) as import('../src/web/types.ts').ForgeAppsResponse
  assert.deepEqual(before.apps[0]!.user, {}, '注册后可以授权，还没人授权')
  const page = await r.authorize()
  assert.equal(page, '/#/forges?authorized=octo')
  const authz = r.requests().find(q => q.path === '/login/oauth/authorize') as unknown as { query: Record<string, string> }
  assert.equal(authz.query.redirect_uri, `${r.web.base}/api/forge-apps/user-callback`)
  const saved = r.credentials.get(LOCAL_OWNER, r.user)
  assert.equal(saved.kind, 'ok')
  const value = JSON.parse((saved as { value: string }).value)
  assert.deepEqual(Object.keys(value).sort(), ['accessToken', 'clientId', 'expiresAt', 'login', 'refreshExpiresAt', 'refreshToken'])
  assert.equal(value.login, 'octo')
  assert.equal(r.credentials.list(LOCAL_OWNER).find(i => i.name === r.user)?.kind, 'github-user')
  const after = (await (await fetch(`${r.web.base}/api/forge-apps`)).json()) as import('../src/web/types.ts').ForgeAppsResponse
  assert.equal((after.apps[0]!.user?.authorized as { login: string }).login, 'octo')

  // 克隆、推送、开 PR 走一遍：git 和 PR 接口都用授权人的令牌（PR 作者就是授权人）。
  const { task, result } = await runPr(r)
  assert.equal(task.status, 'done', task.failure)
  assert.match(result.detail, /已开 PR #1/)
  assert.ok(r.gitTokens().length > 0 && r.gitTokens().every(t => t === value.accessToken), `git 只用了授权人的令牌：${r.gitTokens().join(',')}`)
  assert.ok(
    r.requests().some(q => q.path.includes('.git/git-receive-pack')),
    '推送过',
  )
  const prCalls = apiCalls(r).filter(q => q.path.includes('/pulls'))
  assert.ok(prCalls.length > 0 && prCalls.every(q => q.auth === `Bearer ${value.accessToken}`), `PR 接口用的是授权人的令牌：${prCalls.map(q => q.auth).join(',')}`)
  // 令牌不落盘：数据目录里找不到用户令牌和刷新令牌。
  for (const f of filesUnder(r.data)) {
    const b = readFileSync(f)
    assert.ok(!b.includes(value.accessToken) && !b.includes(value.refreshToken), `${f} 里有令牌`)
  }
})

test('用户令牌快过期时先续期：并发的只续一次，刷新令牌换新、旧的作废；授权在 GitHub 上被撤销后报中文原因，不改用 App 的身份', async () => {
  const r = await registeredApp({ userTtlS: 60 })
  await r.authorize()
  const first = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  // 有效期只有 60 秒（不到 5 分钟）：每次用之前都要续期。两个任务同时建，只续一次。
  const [a, b] = await Promise.all([r.sup.create({ repo: r.url, workflow: 'feature', request: 'a' }), r.sup.create({ repo: r.url, workflow: 'feature', request: 'b' })])
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]))
  const refreshes = () => r.requests().filter(q => q.path === '/login/oauth/access_token' && (q as unknown as { grant: string }).grant === 'refresh_token').length
  assert.equal(refreshes(), 1, '并发的两次只续了一次')
  const second = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  assert.notEqual(second.accessToken, first.accessToken)
  assert.notEqual(second.refreshToken, first.refreshToken, '刷新令牌换了新的')
  assert.ok(r.gitTokens().includes(second.accessToken) && !r.gitTokens().includes(first.accessToken), '用的是续期后的令牌')
  assert.equal(second.clientId, first.clientId, '续期后仍记着授权给的是哪个 App')

  // 两个 Supervisor（代表命令行和 Web 两个进程）同时续期：锁文件排队，后拿到锁的重新读凭据，发现刚续过就不再续。
  const other = new Supervisor({ store: r.store, executor: new FakeExecutor(async () => PASS), dataDir: r.data, credentials: r.credentials, forges: [r.forge], pollMs: 2 })
  await fetch(`http://${r.credential}/__control/expire-user`)
  const [c1, c2] = await Promise.all([r.sup.create({ repo: r.url, workflow: 'feature', request: 'c1' }), other.create({ repo: r.url, workflow: 'feature', request: 'c2' })])
  assert.ok(c1.ok && c2.ok, JSON.stringify([c1, c2]))
  assert.equal(refreshes(), 2, '两个实例一共只多续了一次')

  // 在 GitHub 上撤销了授权（刷新令牌也作废）：续期失败，报中文原因；不悄悄改用 App 的安装令牌。
  const app = JSON.parse((r.credentials.get(LOCAL_OWNER, `github-app.${r.credential}`) as { value: string }).value)
  const live = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value).accessToken
  const del = await fetch(`http://${r.credential}/api/v3/applications/${app.clientId}/grant`, {
    method: 'DELETE',
    headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}` },
    body: JSON.stringify({ access_token: live }),
  })
  assert.equal(del.status, 204)
  const gitBefore = r.gitTokens().length
  const failed = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'c' })
  assert.equal(failed.ok, false)
  assert.match((failed as { error: string }).error, /授权已失效或过期.*在代码托管页重新授权/)
  assert.equal(r.gitTokens().length, gitBefore, '没有用别的身份去访问仓库')
})

test('撤销授权：先在 GitHub 上撤销，再删掉平台存的令牌；之后改用 App 的安装令牌。拒绝授权、伪造的 state 都不存任何东西', async () => {
  const r = await registeredApp()
  await fetch(`http://${r.credential}/__control/deny-next`)
  const denied = await r.authorize()
  assert.match(new URLSearchParams(denied.split('?')[1]).get('error')!, /取消了授权/)
  assert.equal(r.credentials.get(LOCAL_OWNER, r.user).kind, 'absent')
  const forged = await fetch(`${r.web.base}/api/forge-apps/user-callback?code=abc&state=forged`, { redirect: 'manual' })
  assert.match(new URLSearchParams(forged.headers.get('location')!.split('?')[1]).get('error')!, /不是从本页面发起的/)
  // 注册 App 的 state 不能拿来完成授权（先删掉 App 凭据，才能再发起一次注册拿到 state），反过来也一样。
  const appValue = (r.credentials.get(LOCAL_OWNER, r.name) as { value: string }).value
  r.credentials.delete(LOCAL_OWNER, r.name)
  const regState = new URL(((await (await r.web.post('/api/forge-apps/register', { name: r.name, appName: 'x' })).json()) as { action: string }).action).searchParams.get('state')!
  r.credentials.put(LOCAL_OWNER, r.name, 'github-app', appValue)
  const cross = await fetch(`${r.web.base}/api/forge-apps/user-callback?code=abc&state=${regState}`, { redirect: 'manual' })
  assert.match(new URLSearchParams(cross.headers.get('location')!.split('?')[1]).get('error')!, /不是从本页面发起的/)
  const authState = new URL(((await (await r.web.post('/api/forge-apps/authorize', { name: r.name })).json()) as { url: string }).url).searchParams.get('state')!
  const cross2 = await fetch(`${r.web.base}/api/forge-apps/callback?code=abc&state=${authState}`, { redirect: 'manual' })
  assert.match(new URLSearchParams(cross2.headers.get('location')!.split('?')[1]).get('error')!, /不是从本页面发起的/)
  assert.equal(r.credentials.get(LOCAL_OWNER, r.user).kind, 'absent')
  // GitHub 带回别的错误：原样说明。
  const authState2 = new URL(((await (await r.web.post('/api/forge-apps/authorize', { name: r.name })).json()) as { url: string }).url).searchParams.get('state')!
  const suspended = await fetch(`${r.web.base}/api/forge-apps/user-callback?error=application_suspended&error_description=suspended&state=${authState2}`, { redirect: 'manual' })
  assert.match(new URLSearchParams(suspended.headers.get('location')!.split('?')[1]).get('error')!, /GitHub 没有完成授权：application_suspended（suspended）/)

  await r.authorize()
  // 凭据页不能手填用户授权。
  assert.equal((await r.web.post('/api/credentials', { name: r.user, kind: 'github-user', value: '{}' })).status, 400)
  assert.equal((await r.web.post('/api/credentials', { name: 'x', kind: 'github-user', value: '{}' })).status, 400)
  const revoked = (await (await r.web.post('/api/forge-apps/revoke', { name: r.name })).json()) as { ok: boolean; warning?: string }
  assert.deepEqual(revoked, { ok: true })
  assert.ok(
    r.requests().some(q => q.path.endsWith('/grant') && (q as unknown as { ok: boolean }).ok),
    '在 GitHub 上撤销了',
  )
  assert.equal(r.credentials.get(LOCAL_OWNER, r.user).kind, 'absent')
  const created = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'x' })
  assert.equal(created.ok, true, JSON.stringify(created))
  assert.ok(r.gitTokens().at(-1)!.startsWith('ghs_'), '撤销后用 App 的安装令牌')
  assert.equal((await r.web.post('/api/forge-apps/revoke', { name: r.name })).status, 404)
})

test('早先注册的 App（凭据里没有 client id）：页面说明要重新注册，发起授权返回 409', async () => {
  const r = await remote(TOKEN)
  const web = await webOn(r)
  const { generateKeyPairSync } = await import('node:crypto')
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  r.credentials.put(LOCAL_OWNER, `github-app.${r.credential}`, 'github-app', JSON.stringify({ appId: '1', privateKey: pem, slug: 'old' }))
  const list = (await (await fetch(`${web.base}/api/forge-apps`)).json()) as import('../src/web/types.ts').ForgeAppsResponse
  assert.match(list.apps[0]!.user!.unavailable!, /没有记下 client id 和 secret.*重新注册/)
  const res = await web.post('/api/forge-apps/authorize', { name: `github-app.${r.credential}` })
  assert.equal(res.status, 409)
})

test('用户授权：App 记下了注册时的回调地址，换了访问地址发起授权时说明要用哪个地址；授权人的令牌被拒后，下次先续期', async () => {
  const r = await registeredApp()
  const app = JSON.parse((r.credentials.get(LOCAL_OWNER, r.name) as { value: string }).value)
  assert.equal(app.userCallbackUrl, `${r.web.base}/api/forge-apps/user-callback`)
  // 用另一个地址（localhost 而不是 127.0.0.1）打开平台：发起授权返回 409，说明要用哪个地址。
  const other = r.web.base.replace('127.0.0.1', 'localhost')
  const res = await fetch(`${other}/api/forge-apps/authorize`, { method: 'POST', headers: { origin: other, 'content-type': 'application/json' }, body: JSON.stringify({ name: r.name }) })
  assert.equal(res.status, 409)
  const said = (await res.json()).error as string
  assert.ok(said.includes(`用 ${r.web.base} 打开平台后再授权`), said)

  await r.authorize()
  const first = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  // 令牌还没到续期时间就失效了（例如在 GitHub 上撤销后又重新授权，旧令牌作废）：访问失败后，下次用之前先续期。
  await fetch(`http://${r.credential}/__control/expire-user`)
  const failed = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'a' })
  assert.equal(failed.ok, false)
  const ok = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'b' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  const second = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  assert.notEqual(second.accessToken, first.accessToken, '续期换了新令牌')
  assert.ok(r.gitTokens().at(-1) === second.accessToken)
})

test('撤销时令牌已经过期：先续期再撤销，GitHub 上真的撤销了；GitHub 不认令牌时提醒手动撤销，不说成功', async () => {
  const r = await registeredApp()
  await r.authorize()
  // 令牌 8 小时没用就过期了：直接拿它去撤销，GitHub 会回 404、授权还在。平台要先续期。
  await fetch(`http://${r.credential}/__control/expire-user`)
  const value = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  r.credentials.put(LOCAL_OWNER, r.user, 'github-user', JSON.stringify({ ...value, expiresAt: Date.now() - 1000 }))
  const revoked = (await (await r.web.post('/api/forge-apps/revoke', { name: r.name })).json()) as { ok: boolean; warning?: string }
  assert.deepEqual(revoked, { ok: true })
  assert.ok(
    r.requests().some(q => q.path.endsWith('/grant') && (q as unknown as { ok: boolean }).ok),
    'GitHub 上撤销了',
  )

  // 平台存的令牌 GitHub 不认（例如已经在 GitHub 上撤销过、存的到期时间不准）：照样删掉，但提醒去 GitHub 上确认。
  await r.authorize()
  const v2 = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  await fetch(`http://${r.credential}/__control/expire-user`)
  const again = (await (await r.web.post('/api/forge-apps/revoke', { name: r.name })).json()) as { ok: boolean; warning?: string }
  assert.equal(again.ok, true)
  assert.match(again.warning!, /没能确认 @octo 的授权已撤销.*Authorized GitHub Apps/)
  assert.equal(r.credentials.get(LOCAL_OWNER, r.user).kind, 'absent')
  assert.ok(v2.accessToken)
})

test('续期等 GitHub 回复期间有人换人重新授权或撤销：以那边为准，不把旧授权人的令牌写回去', async () => {
  const r = await registeredApp({ userTtlS: 60 })
  await r.authorize()
  await fetch(`http://${r.credential}/__control/slow-refresh`)
  // 换人重新授权：续期期间凭据被换成另一个人的（这里直接写入，模拟授权回调）。
  const other = JSON.stringify({
    login: 'someone-else',
    accessToken: 'ghu_other_not_valid_for_git_0001',
    clientId: JSON.parse((r.credentials.get(LOCAL_OWNER, r.name) as { value: string }).value).clientId,
  })
  const running = r.sup.create({ repo: r.url, workflow: 'feature', request: 'a' })
  await new Promise(ok => setTimeout(ok, 300))
  r.credentials.put(LOCAL_OWNER, r.user, 'github-user', other)
  await running
  assert.equal((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value, other, '续期的结果没有覆盖新授权')
  assert.equal(r.gitTokens().at(-1), 'ghu_other_not_valid_for_git_0001', '这次用的是新授权人的令牌')

  // 撤销：续期期间凭据被删掉，续期完不写回去，这次改用 App 的身份。
  r.credentials.delete(LOCAL_OWNER, r.user)
  await r.authorize()
  const pending = r.sup.create({ repo: r.url, workflow: 'feature', request: 'b' })
  await new Promise(ok => setTimeout(ok, 300))
  r.credentials.delete(LOCAL_OWNER, r.user)
  const done = await pending
  assert.equal(done.ok, true, JSON.stringify(done))
  assert.equal(r.credentials.get(LOCAL_OWNER, r.user).kind, 'absent', '撤销后没有被续期写回来')
  assert.ok(r.gitTokens().at(-1)!.startsWith('ghs_'), '改用 App 的安装令牌')
})

test('删掉 App 重新注册后，旧 App 的授权用不了：说清楚要重新授权，不拿它去试', async () => {
  const r = await registeredApp()
  await r.authorize()
  r.credentials.delete(LOCAL_OWNER, r.name)
  const started = (await (await r.web.post('/api/forge-apps/register', { name: r.name, appName: 'eos-new' })).json()) as { action: string; fields: Record<string, string> }
  await submitManifest(started.action, started.fields)
  const gitBefore = r.gitTokens().length
  const failed = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'x' })
  assert.equal(failed.ok, false)
  assert.match((failed as { error: string }).error, /给之前注册的那个 App 的.*重新授权/)
  assert.equal(r.gitTokens().length, gitBefore)
  const list = (await (await fetch(`${r.web.base}/api/forge-apps`)).json()) as import('../src/web/types.ts').ForgeAppsResponse
  assert.match((list.apps[0]!.user!.authorized as { error: string }).error, /之前注册的那个 App/)
})

test('只有认证被拒才在下次先续期：开 PR 因别的原因失败不续期；续期暂时出错时，下次仍先续期，不拿被拒过的令牌再试', async () => {
  const r = await registeredApp()
  await r.authorize()
  const refreshes = () => r.requests().filter(q => q.path === '/login/oauth/access_token' && (q as unknown as { grant: string }).grant === 'refresh_token').length
  // 开 PR 失败，但不是认证被拒（422）：下次不续期。用同一个 Supervisor（"被拒过"的记号在它里面）。
  await fetch(`http://${r.credential}/__control/fail-post?status=422`)
  const { task } = await runPr(r, { sup: r.sup })
  assert.equal(task.status, 'failed')
  await fetch(`http://${r.credential}/__control/fail-post?status=0`)
  assert.equal((await r.sup.create({ repo: r.url, workflow: 'feature', request: 'a' })).ok, true)
  assert.equal(refreshes(), 0, '非认证的失败不触发续期')

  // 令牌被拒（GitHub 上让它失效，平台记的到期时间还早）：访问失败，打上记号。
  await fetch(`http://${r.credential}/__control/expire-user`)
  assert.equal((await r.sup.create({ repo: r.url, workflow: 'feature', request: 'b' })).ok, false)
  // 下次先续期，但 GitHub 暂时出错：失败，记号还在。
  await fetch(`http://${r.credential}/__control/fail-refresh?times=1`)
  const failed = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'c' })
  assert.equal(failed.ok, false)
  assert.match((failed as { error: string }).error, /temporarily_unavailable/)
  const gitBefore = r.gitTokens().length
  // 再下次：仍然先续期（不拿被拒过的令牌去试），这次成功。
  const ok = await r.sup.create({ repo: r.url, workflow: 'feature', request: 'd' })
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(refreshes(), 2, '续期出错后又续了一次')
  const value = JSON.parse((r.credentials.get(LOCAL_OWNER, r.user) as { value: string }).value)
  assert.ok(
    r
      .gitTokens()
      .slice(gitBefore)
      .every(t => t === value.accessToken),
    '没有再用被拒过的令牌',
  )
})
