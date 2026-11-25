// 用户授权（OAuth）的浏览器 E2E：GitHub 由 tests/git-server-main.ts 模拟，平台是真实的 Web 服务和构建好的页面（web/dist）。
// 步骤：注册 App → 装到私有仓库 acme/app → 在代码托管页点「用 GitHub 账号授权」→ 浏览器去「GitHub」授权页、跳回平台 →
// 页面显示授权人 → 在页面上建一个会推送并开 PR 的任务（agent 是假的，每次往 worktree 写一个文件）→ 核对克隆、推送、开 PR 都用授权人的令牌；
// 再撤销授权，核对 GitHub 上撤销了、平台不再存令牌。核对页面、接口响应、数据目录、任务日志里都没有用户令牌和刷新令牌。
// 用法：node --import tsx scripts/forge-user-auth-e2e.ts <输出目录>   （先 npm run build:web）
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { parseMasterKey, type MasterKey } from '../src/credentials/key.ts'
import { redactText } from '../src/credentials/redact.ts'
import { Credentials } from '../src/credentials/store.ts'
import { LOCAL_OWNER } from '../src/credentials/types.ts'
import { githubForge } from '../src/forge/github.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { createWebServer } from '../src/web/server.ts'
import { FakeExecutor } from '../tests/fake-executor.ts'
import { PASS } from '../tests/helpers.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const out = process.argv[2] ?? join(ROOT, '.eos', 'forge-user-auth')
const dir = join(ROOT, '.eos', 'forge-user-auth-data')
rmSync(dir, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 模拟的 GitHub：acme/app 是私有仓库（git 要认证）。
const bare = join(dir, 'remote', 'acme', 'app.git')
mkdirSync(bare, { recursive: true })
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare])
const work = join(dir, 'work')
mkdirSync(work)
const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd: work, stdio: 'ignore' })
g('init', '-q', '-b', 'main')
writeFileSync(join(work, 'README.md'), 'hi\n')
g('add', '-A')
g('commit', '-q', '-m', 'init')
g('push', '-q', bare, 'HEAD:main')
const record = join(dir, 'requests.jsonl')
writeFileSync(record, '')
const gh = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests', 'git-server-main.ts'), join(dir, 'remote'), 'ghp_not_stored_anywhere_0123456789', record], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'inherit'],
})
process.on('exit', () => gh.kill())
const ghPort = await new Promise<number>(r =>
  gh.stdout!.on('data', (b: Buffer) => {
    const m = /port (\d+)/.exec(b.toString())
    if (m) r(Number(m[1]))
  }),
)
const host = `127.0.0.1:${ghPort}`
const requests = () =>
  readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as { path: string; auth?: string | null; method?: string; ok?: boolean })

const data = join(dir, 'data')
const key = (parseMasterKey(Buffer.alloc(32, 9).toString('base64')) as { key: MasterKey }).key
const store = new Store(join(data, 'eos.db'))
const credentials = new Credentials(join(data, 'eos.db'), key)
const lines: string[] = []
// 假的 agent：开发每次往 worktree 写一个文件（平台随后提交），评审直接通过。
const executor = new FakeExecutor(async ({ key: k }) => {
  if (k.endsWith('/review')) return PASS
  writeFileSync(join(store.meta(k.split('/')[0]!).worktree, 'feature.txt'), 'new\n')
  return '改好了'
})
const sup = new Supervisor({ store, executor, dataDir: data, credentials, forges: [githubForge({ host, scheme: 'http' })], pollMs: 5, log: (id, l) => lines.push(`${id} ${l}`) })
// 一个推送并开 PR 的工作流（和单元测试里的 ship-pr 一样）。
sup.conventions.save(
  {
    kind: 'workflow',
    name: 'ship-pr',
    actor: 'e2e',
    content: `name: ship-pr
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
    task: 推送任务分支并开 PR。
    maxRounds: 1
    checks:
      - { run: [git, --version] }
      - { platform: pull-request }
`,
  },
  Date.now(),
)
const server = createWebServer({ store, supervisor: sup, replay: { traceOf: async () => [] }, staticDir: join(ROOT, 'web', 'dist'), credentials })
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const checks: Record<string, boolean> = {}
const responses: string[] = []
const errors: string[] = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m: any) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})
page.on('response', async (r: any) => {
  if (r.url().startsWith(base) && r.url().includes('/api/')) responses.push(await r.text().catch(() => ''))
})

// 1. 注册 App，装到 acme/app。
await page.goto(`${base}/#/forges`)
await page.getByLabel('App 名字').fill('Eos-OAuth')
await page.getByRole('button', { name: `到 ${host} 注册` }).click()
await page.waitForSelector('text=已注册 App「Eos-OAuth」')
await fetch(`http://${host}/__control/install?repo=acme/app`)
await page.waitForSelector(`text=用 ${host} 账号授权`)
await page.screenshot({ path: join(out, '1-registered.png') })

// 2. 用 GitHub 账号授权：浏览器去授权页（模拟的直接跳回），跳回后页面显示授权人。
await page.getByRole('button', { name: `用 ${host} 账号授权` }).click()
await page.waitForSelector('text=已用 @octo 的 GitHub 账号授权')
await page.waitForSelector('text=已授权：')
checks['授权后页面显示授权人 @octo'] = (await page.locator('.forge-user').innerText()).includes('@octo')
checks['授权页的回调地址是注册时登记的那个'] = requests().some(
  r => r.path === '/login/oauth/authorize' && (r as unknown as { query: Record<string, string> }).query.redirect_uri === `${base}/api/forge-apps/user-callback`,
)
checks['显示结果后地址回到 #/forges（不留 code 和 state）'] = page.url() === `${base}/#/forges`
await page.screenshot({ path: join(out, '2-authorized.png') })
const saved = credentials.get(LOCAL_OWNER, `github-user.${host}`)
const user = saved.kind === 'ok' ? (JSON.parse(saved.value) as { login: string; accessToken: string; refreshToken: string }) : undefined
checks['凭据存储里有授权人的令牌和刷新令牌'] = user?.login === 'octo' && user.accessToken.startsWith('ghu_') && user.refreshToken.startsWith('ghr_')

// 3. 在页面上建一个推送并开 PR 的任务。
await page.goto(`${base}/#/new`)
await page.getByLabel('仓库').fill(`http://${host}/acme/app`)
await page.getByLabel('工作流').selectOption('ship-pr')
await page.getByLabel('需求').fill('E2E：以授权人的身份推送并开 PR')
await page.getByRole('button', { name: /创建/ }).click()
await page.waitForURL(/#\/tasks\//, { timeout: 60_000 })
const id = /#\/tasks\/([\w-]+)/.exec(page.url())![1]!
for (let i = 0; i < 300 && !['done', 'failed'].includes(store.get(id)?.status ?? ''); i++) await new Promise(r => setTimeout(r, 200))
await page.reload()
await page.waitForSelector('text=PR #1', { timeout: 30_000 })
await page.screenshot({ path: join(out, '3-task-pr.png'), fullPage: true })
checks['任务完成，开了 PR #1'] = store.get(id)?.status === 'done'
const all = requests()
const gitTokens = all
  .filter(r => r.path.includes('.git/') && typeof r.auth === 'string')
  .map(
    r =>
      Buffer.from(r.auth!.replace(/^Basic /, ''), 'base64')
        .toString('utf8')
        .split(':')[1],
  )
checks['克隆、推送都用授权人的令牌'] = gitTokens.length > 0 && gitTokens.every(t => t === user?.accessToken) && all.some(r => r.path.includes('git-receive-pack'))
const prCalls = all.filter(r => r.path.includes('/pulls'))
checks['开 PR 用授权人的令牌（PR 作者是授权人）'] = prCalls.length > 0 && prCalls.every(r => r.auth === `Bearer ${user?.accessToken}`)

// 4. 撤销授权：GitHub 上撤销了，平台不再存令牌，页面回到「用 GitHub 账号授权」。
await page.goto(`${base}/#/forges`)
page.once('dialog', (d: any) => d.accept())
await page.getByRole('button', { name: '撤销授权' }).click()
await page.waitForSelector('text=已撤销 @octo 的授权')
checks['撤销后 GitHub 上的授权也撤销了'] = requests().some(r => r.path.endsWith('/grant') && r.ok === true)
checks['撤销后平台不再存令牌'] = credentials.get(LOCAL_OWNER, `github-user.${host}`).kind === 'absent'
await page.screenshot({ path: join(out, '4-revoked.png') })

const narrow = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 })
await narrow.goto(`${base}/#/forges`)
await narrow.waitForSelector(`text=用 ${host} 账号授权`)
checks['390 宽没有横向滚动'] = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0)
await narrow.screenshot({ path: join(out, '5-390.png'), fullPage: true })
await browser.close()

const filesUnder = (d: string): string[] =>
  readdirSync(d).flatMap(n => {
    const f = join(d, n)
    return statSync(f, { throwIfNoEntry: false })?.isDirectory() ? filesUnder(f) : [f]
  })
const secrets = [user?.accessToken ?? 'missing', user?.refreshToken ?? 'missing']
const leak = (s: string | Buffer) => redactText(s.toString(), secrets) !== s.toString()
checks['接口响应里没有用户令牌和刷新令牌'] = responses.length > 0 && !responses.some(leak)
checks['数据目录里没有用户令牌和刷新令牌的明文'] = !filesUnder(data).some(f => leak(readFileSync(f)))
checks['任务日志里没有用户令牌'] = !lines.some(leak)
checks['页面没有报错'] = errors.length === 0

const report = { checks, passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length, errors }
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
server.close()
process.exit(report.passed === report.total ? 0 : 1)
