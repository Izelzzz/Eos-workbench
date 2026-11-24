// 凭据页的 E2E：启动真实的 eos web（带主密钥），用 Playwright 在页面上保存、替换、删除凭据，截图。
// 核对：页面、接口响应、服务的输出、数据目录里的所有文件（数据库、WAL、日志）都找不到凭据的值；
// 再不带主密钥启动一次，截图页面上的说明，并确认保存按钮不可用。结果写到 <输出目录>/report.json。
// 用法：node --import tsx scripts/credentials-web-e2e.ts <输出目录>
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const out = process.argv[2] ?? join(ROOT, '.eos', 'credentials-web')
const data = join(ROOT, '.eos', 'credentials-web-data')
rmSync(data, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const VALUE = `ghp_e2e_${randomBytes(12).toString('hex')}`
const VALUE2 = `ghp_e2e_${randomBytes(12).toString('hex')}`
const key = randomBytes(32).toString('base64')

const servers: ChildProcess[] = []
process.on('exit', () => { for (const p of servers) p.kill('SIGKILL') })

const start = (port: number, withKey: boolean) => new Promise<{ p: ChildProcess; output: () => string }>((resolve, reject) => {
  let output = ''
  const env = { ...process.env, DEEPSEEK_API_KEY: 'unused-in-this-e2e', ...(withKey ? { EOS_MASTER_KEY: key } : {}) }
  if (!withKey) delete env.EOS_MASTER_KEY
  const p = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--port', String(port), '--data', data], { cwd: ROOT, env })
  servers.push(p)
  const on = (b: Buffer) => {
    output += b.toString()
    if (/http:\/\/127\.0\.0\.1:\d+/.test(output)) resolve({ p, output: () => output })
  }
  p.stdout.on('data', on)
  p.stderr.on('data', on)
  p.on('exit', c => reject(new Error(`eos web 退出了（${c}）：${output}`)))
})

const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const f = join(dir, n)
  return statSync(f).isDirectory() ? filesUnder(f) : [f]
})

const checks: Record<string, boolean> = {}
const responses: string[] = []
const browser = await chromium.launch()
const errors: string[] = []

const withPage = async (base: string, scale = 2) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: scale })
  page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m: any) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`) })
  page.on('response', async (r: any) => { if (r.url().includes('/api/')) responses.push(await r.text().catch(() => '')) })
  await page.goto(`${base}/#/credentials`)
  return page
}

// 1. 带主密钥：保存、替换、删除。
const a = await start(4391, true)
const base = 'http://127.0.0.1:4391'
let page = await withPage(base)
await page.waitForSelector('text=还没有凭据。')
await page.getByLabel('名字').fill('github.com')
await page.getByLabel('值').fill(VALUE)
await page.screenshot({ path: join(out, '1-filling.png') })
checks['值输入框是密码框，截图里看不到明文'] = (await page.getByLabel('值').getAttribute('type')) === 'password'
await page.getByRole('button', { name: '保存' }).click()
await page.waitForSelector('text=已保存凭据 github.com')
checks['保存后输入框清空'] = (await page.getByLabel('值').inputValue()) === ''
await page.getByLabel('名字').fill('deepseek')
await page.getByRole('combobox').selectOption('api-key')
await page.getByLabel('值').fill(VALUE2)
await page.getByRole('button', { name: '保存' }).click()
await page.waitForSelector('text=已保存凭据 deepseek')
await page.screenshot({ path: join(out, '2-saved.png') })
const rows = await page.locator('table.tasks tbody tr').allInnerTexts()
checks['列表显示两条凭据和类型'] = rows.length === 2 && rows[0]!.includes('deepseek') && rows[0]!.includes('模型 API key') && rows[1]!.includes('github.com') && rows[1]!.includes('Git 令牌')
await page.getByLabel('名字').fill('github.com')
await page.getByLabel('值').fill(`${VALUE}-replaced`)
await page.getByRole('button', { name: '保存' }).click()
await page.waitForSelector('text=已替换凭据 github.com')
checks['同名保存是替换，类型沿用原来的'] = (await page.locator('table.tasks tbody tr').count()) === 2
  && (await page.locator('table.tasks tbody tr', { hasText: 'github.com' }).innerText()).includes('Git 令牌')
await page.reload()
await page.waitForSelector('table.tasks tbody tr')
const html = await page.content()
checks['页面 HTML 里没有值（刷新后）'] = !html.includes(VALUE) && !html.includes(VALUE2)
page.once('dialog', (d: any) => d.accept())
await page.locator('table.tasks tbody tr', { hasText: 'deepseek' }).getByRole('button', { name: '删除' }).click()
await page.waitForSelector('text=已删除凭据 deepseek')
checks['删除后列表只剩一条'] = (await page.locator('table.tasks tbody tr').count()) === 1
await page.screenshot({ path: join(out, '3-deleted.png') })
// 390 宽：没有横向滚动。
const narrow = await browser.newPage({ viewport: { width: 390, height: 800 }, deviceScaleFactor: 2 })
await narrow.goto(`${base}/#/credentials`)
await narrow.waitForSelector('table.tasks tbody tr')
checks['390 宽没有横向滚动'] = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 0)
await narrow.screenshot({ path: join(out, '4-390.png'), fullPage: true })
a.p.kill('SIGTERM')
await new Promise(r => a.p.once('exit', r))
const serverOutput = a.output()

// 2. 不带主密钥：页面说明怎么设置，保存按钮不可用。
const b = await start(4392, false)
page = await withPage('http://127.0.0.1:4392')
await page.waitForSelector('text=平台没有主密钥，不能保存凭据')
checks['没有主密钥时页面写明怎么设置'] = (await page.locator('.error').innerText()).includes('openssl rand -base64 32')
checks['没有主密钥时保存按钮不可用'] = await page.getByRole('button', { name: '保存' }).isDisabled()
checks['没有主密钥时仍能列出已有凭据'] = (await page.locator('table.tasks tbody tr').count()) === 1
await page.screenshot({ path: join(out, '5-no-master-key.png') })
b.p.kill('SIGTERM')
await new Promise(r => b.p.once('exit', r))
await browser.close()

const all = [VALUE, VALUE2, `${VALUE}-replaced`]
const leakIn = (s: string | Buffer) => all.some(v => s.includes(v))
const dataFiles = filesUnder(data)
checks['接口响应里没有值'] = responses.length > 0 && !responses.some(leakIn)
checks['服务的输出里没有值'] = !leakIn(serverOutput) && !leakIn(b.output())
checks['数据目录（数据库、WAL、日志）里没有值'] = dataFiles.length > 0 && !dataFiles.some(f => leakIn(readFileSync(f)))
checks['页面没有报错'] = errors.length === 0

const report = { checks, passed: Object.values(checks).filter(Boolean).length, total: Object.keys(checks).length, responses: responses.length, dataFiles: dataFiles.map(f => f.slice(data.length + 1)), errors }
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.passed === report.total ? 0 : 1)
