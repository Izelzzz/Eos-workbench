// 代码托管页的 E2E：在浏览器里走一遍清单流程注册 GitHub App，GitHub 由 tests/git-server-main.ts 模拟。
// 平台这边是真实的 Web 服务和构建好的页面（web/dist），只是托管平台指向模拟的 GitHub（真实 GitHub 要在用户的浏览器里注册，见 PR 描述）。
// 步骤：打开代码托管页 → 填名字、点注册 → 浏览器把清单提交到「GitHub」→ 跳回平台回调 → 页面显示已注册和安装链接；
// 再把 App 装到测试仓库，在页面上建任务，确认克隆用的是 App 换来的令牌。核对页面、接口响应、数据目录里都没有私钥和令牌。
// 用法：node --import tsx scripts/forge-app-register-e2e.ts <输出目录>   （先 npm run build:web）
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
const out = process.argv[2] ?? join(ROOT, '.eos', 'forge-app-register')
const dir = join(ROOT, '.eos', 'forge-app-register-data')
rmSync(dir, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// 模拟的 GitHub：acme/app 是私有仓库（git 要认证），App 由注册流程现场生成。
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
const gh = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'tests', 'git-server-main.ts'), join(dir, 'remote'), 'ghp_not_stored_anywhere_0123456789', record], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
process.on('exit', () => gh.kill())
const ghPort = await new Promise<number>(r => gh.stdout!.on('data', (b: Buffer) => { const m = /port (\d+)/.exec(b.toString()); if (m) r(Number(m[1])) }))
const host = `127.0.0.1:${ghPort}`

const data = join(dir, 'data')
const key = (parseMasterKey(Buffer.alloc(32, 9).toString('base64')) as { key: MasterKey }).key
const store = new Store(join(data, 'eos.db'))
const credentials = new Credentials(join(data, 'eos.db'), key)
const lines: string[] = []
const sup = new Supervisor({ store, executor: new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : '回复')), dataDir: data, credentials, forges: [githubForge({ host, scheme: 'http' })], pollMs: 5, log: (id, l) => lines.push(`${id} ${l}`) })
const server = createWebServer({ store, supervisor: sup, replay: { traceOf: async () => [] }, staticDir: join(ROOT, 'web', 'dist'), credentials })
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const checks: Record<string, boolean> = {}
const responses: string[] = []
const errors: string[] = []
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m: any) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
page.on('response', async (r: any) => { if (r.url().startsWith(base) && r.url().includes('/api/')) responses.push(await r.text().catch(() => '')) })

// 先走一次失败的回调（不是本页面发起的 state）：页面显示原因，不存任何东西。
await page.goto(`${base}/api/forge-apps/callback?code=x&state=forged`)
await page.waitForSelector('text=注册没有完成')
checks['回调失败时页面写明原因和要去删 App'] = (await page.locator('.error').innerText()).includes('到托管平台的 App 设置里删掉它') && credentials.list(LOCAL_OWNER).length === 0
await page.screenshot({ path: join(out, '0-callback-error.png') })
await page.goto(`${base}/#/forges`)
await page.waitForSelector(`text=GitHub App · ${host}`)
await page.getByLabel('App 名字').fill('Eos-E2E')
checks['页面写明回调地址'] = (await page.locator('.forge-app').innerText()).includes(`${base}/api/forge-apps/callback`)
await page.screenshot({ path: join(out, '1-before.png') })
await page.getByRole('button', { name: `到 ${host} 注册` }).click()
await page.waitForSelector('text=已注册 App「Eos-E2E」')
await page.waitForSelector('text=把 App 安装到仓库')
await page.screenshot({ path: join(out, '2-registered.png') })
await page.reload()
await page.waitForSelector('text=把 App 安装到仓库')
checks['刷新后不再显示这次注册的结果'] = (await page.locator('text=已注册 App「Eos-E2E」').count()) === 0
const went = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { path: string; manifest?: { redirect_url: string } })
checks['浏览器把清单提交到了 GitHub 的注册页'] = went.some(r => r.path.startsWith('/settings/apps/new?state=') && r.manifest?.redirect_url === `${base}/api/forge-apps/callback`)
checks['显示结果后地址回到 #/forges（不留 code、state 和结果）'] = page.url() === `${base}/#/forges`
const installHref = await page.getByRole('link', { name: '把 App 安装到仓库' }).getAttribute('href')
checks['安装链接指向这个 App 的安装页'] = installHref === `http://${host}/apps/eos-e2e/installations/new`
const saved = credentials.get(LOCAL_OWNER, `github-app.${host}`)
const value = saved.kind === 'ok' ? JSON.parse(saved.value) as { appId: string; privateKey: string; slug: string } : undefined
checks['凭据存储里有 App 凭据（id、私钥、短名、页面地址，以及用户授权用的 client id、secret 和回调地址；不存 webhook secret）'] = value !== undefined && Object.keys(value).sort().join() === 'appId,clientId,clientSecret,htmlUrl,privateKey,slug,userCallbackUrl'

// 装到仓库，在页面上建任务：克隆用 App 的令牌（凭据存储里没有个人令牌，私有仓库只能这样访问）。
await fetch(`http://${host}/__control/install?repo=acme/app`)
await page.goto(`${base}/#/new`)
await page.getByLabel('仓库').fill(`http://${host}/acme/app`)
await page.getByLabel('需求').fill('E2E：确认 App 能访问私有仓库')
await page.getByRole('button', { name: /创建/ }).click()
await page.waitForURL(/#\/tasks\//, { timeout: 60_000 })
await page.screenshot({ path: join(out, '3-task.png') })
const after = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { path: string })
checks['建任务时换了 App 的安装令牌'] = after.some(r => r.path === '/api/v3/app/installations/1000/access_tokens')
checks['任务建在 App 克隆的镜像上'] = store.list().length === 1

const narrow = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 })
await narrow.goto(`${base}/#/forges`)
await narrow.waitForSelector('text=已注册')
checks['390 宽没有横向滚动'] = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0)
await narrow.screenshot({ path: join(out, '4-390.png'), fullPage: true })
await browser.close()

const filesUnder = (d: string): string[] => readdirSync(d).flatMap(n => {
  const f = join(d, n)
  return statSync(f, { throwIfNoEntry: false })?.isDirectory() ? filesUnder(f) : [f]
})
const secret = value?.privateKey ?? 'missing'
// 私钥在数据库里是密文；数据目录里任何文件都不该有它的明文（或它在 JSON 里的转义写法、base64 写法）。
// 只漏一部分也要查出来：去掉头尾的 base64 正文，以及正文的每一行（64 个字符）。
const body = secret.split('\n').filter(l => l !== '' && !l.startsWith('-----'))
const parts = [secret, body.join(''), body.join('\n'), ...body.filter(l => l.length >= 40)]
const leak = (s: string | Buffer) => redactText(s.toString(), parts) !== s.toString()
checks['接口响应里没有私钥'] = responses.length > 0 && !responses.some(leak)
checks['数据目录里没有私钥的明文'] = !filesUnder(data).some(f => leak(readFileSync(f)))
checks['任务日志里没有私钥'] = !lines.some(leak)
checks['页面没有报错'] = errors.length === 0

const report = { checks, passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length, errors }
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
server.close()
process.exit(report.passed === report.total ? 0 : 1)
