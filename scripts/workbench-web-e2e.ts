// 工作台页面（web/src/workbench）的浏览器核对，不调用模型：用 scripts/workbench-fixture.ts 摆好的数据起服务，
// 核对首页是工作台、两栏布局、等你处理和进行中的任务、导航的小圆点、跳转，并截图（亮暗色 × 1440/390），另和设计稿并排截一张。
// 用法：node --import tsx scripts/workbench-web-e2e.ts <输出目录>（先 npm run build:web）
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: (o?: unknown) => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const out = process.argv[2]
if (out === undefined) throw new Error('用法：workbench-web-e2e.ts <输出目录>')
mkdirSync(out, { recursive: true })

const codeState = (): { commit?: string; uncommitted?: string[] } => {
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const uncommitted = git('status', '--porcelain', '-z', '--no-renames', '--untracked-files=all')
      .split('\0')
      .filter(Boolean)
      .map(l => l.slice(3))
    return { commit: git('rev-parse', 'HEAD').trim(), uncommitted }
  } catch {
    return {}
  }
}
const atStart = codeState()

const port = 43941
const base = `http://127.0.0.1:${port}`
let server: ChildProcess | undefined
process.on('exit', () => server?.kill('SIGKILL'))
await new Promise<void>((resolve, reject) => {
  let output = ''
  const p = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'workbench-fixture.ts'), mkdtempSync(join(tmpdir(), 'eos-wb-')), '--serve', String(port)], { cwd: ROOT })
  server = p
  const on = (c: Buffer) => {
    output += c.toString()
    if (output.includes(base)) resolve()
  }
  p.stdout.on('data', on)
  p.stderr.on('data', on)
  p.on('exit', c => reject(new Error(`数据服务退出了（${c}）：${output}`)))
})

const checks: Record<string, boolean> = {}
const check = (name: string, ok: boolean) => {
  checks[name] = ok
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`)
}
const errors: string[] = []
const browser = await chromium.launch()
const open = async (width: number, scheme: 'light' | 'dark' = 'light') => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: scheme })
  const page = await context.newPage()
  await page.clock.setFixedTime(new Date('2026-11-28T12:00:00Z'))
  // 只记工作台页面上的错误：摆好的任务没有真的仓库，点进任务详情后读改动会失败（那是任务详情页，不在这里核对）
  const onWorkbench = () => /#\/$/.test(page.url())
  page.on('pageerror', (e: Error) => onWorkbench() && errors.push(`${width} ${scheme} pageerror: ${e.message}`))
  page.on('console', (m: any) => m.type() === 'error' && onWorkbench() && errors.push(`${width} ${scheme} console: ${m.text()}`))
  await page.goto(`${base}/#/`)
  await page.waitForSelector('[aria-labelledby=wb-active] [data-slot=task-row]')
  await page.waitForTimeout(300)
  return page
}
const pending = (page: any) => page.locator('[aria-labelledby=wb-pending]')
const active = (page: any) => page.locator('[aria-labelledby=wb-active]')

// ---- 宽屏 ----
{
  const page = await open(1440)
  const nav = page.getByRole('navigation', { name: '主导航' })
  check('首页 #/ 是工作台，导航当前项是「工作台」', (await nav.locator('a[aria-current="page"]').getAttribute('href')) === '#/')
  check(
    '导航「工作台」的读屏名字带上件数，有小圆点',
    (await nav.locator('a').first().getAttribute('aria-label')) === '工作台，3 件等你处理' && (await nav.locator('[data-slot=waiting-dot]').count()) === 1,
  )
  check(
    '等你处理：3 件，按出现先后（提案、验收、提问）',
    (await pending(page).locator('h2').innerText()).replace(/\s+/g, '') === '等你处理3' &&
      JSON.stringify(await pending(page).locator('li a > span:first-child').allInnerTexts()) === JSON.stringify(['提案', '验收', '提问']),
  )
  const names = await active(page).locator('[data-slot=task-row]').allInnerTexts()
  check('进行中的任务：6 个，等你处理的两个在前', names.length === 6 && names[0]!.startsWith('导出任务列表为 CSV') && names[1]!.startsWith('任务列表支持按状态筛选'))
  check('进行中的任务：等你处理的两行有强调色圆点', (await active(page).locator('[data-slot=task-row][data-waiting]').count()) === 2)
  check(
    '进度按工作流节点数分段：带卡点的任务 4 段，其余 3 段',
    (await active(page).locator('[data-slot=task-row]').nth(1).locator('i').count()) === 4 && (await active(page).locator('[data-slot=task-row]').nth(0).locator('i').count()) === 3,
  )
  const left = await pending(page).boundingBox()
  const right = await page.locator('aside').boundingBox()
  check('宽屏两栏：右栏 600px 宽、在左栏右边、通到页面底', right.width === 600 && right.x > left.x + left.width && right.y === 0 && right.height >= 900)
  await active(page)
    .getByRole('button', { name: /统计页增加按仓库筛选/ })
    .click()
  await page.waitForTimeout(200)
  check('点一行任务打开任务详情', page.url() === `${base}/#/tasks/t-0145`)
  await page.goto(`${base}/#/`)
  await active(page).getByRole('link', { name: '全部' }).click()
  await page.waitForSelector('table.tasks tbody tr')
  check(
    '「全部」到任务列表 #/tasks，导航当前项是「任务」',
    page.url() === `${base}/#/tasks` && (await page.getByRole('navigation', { name: '主导航' }).locator('a[aria-current="page"]').getAttribute('href')) === '#/tasks',
  )
  await page.goto(`${base}/#/`)
  await pending(page)
    .getByRole('link', { name: /导出任务列表为 CSV/ })
    .click()
  await page.waitForTimeout(200)
  check('等你处理里的提问链到任务详情', page.url() === `${base}/#/tasks/t-0147`)
  await page.context().close()
}

// ---- 窄屏 ----
{
  const page = await open(390)
  const left = await pending(page).boundingBox()
  const right = await page.locator('aside').boundingBox()
  check('窄屏：上下排，进行中的任务在等你处理下面', right.y > left.y + left.height && right.width === 390)
  check('窄屏：不横向滚动', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await page.context().close()
}

// ---- 截图 ----
const shots: string[] = []
for (const scheme of ['light', 'dark'] as const)
  for (const width of [1440, 390]) {
    const page = await open(width, scheme)
    const file = `workbench-${scheme}-${width}.png`
    await page.screenshot({ path: join(out, file), fullPage: true })
    shots.push(file)
    await page.context().close()
  }
// 和设计稿并排（亮色 1440，左设计稿、右正式页面）
{
  const a = await open(1440)
  const right: Buffer = await a.screenshot()
  await a.goto(`file://${join(ROOT, 'docs', 'design', 'workbench.html')}`)
  await a.waitForTimeout(500)
  const left: Buffer = await a.screenshot()
  await a.setViewportSize({ width: 1440 * 2 + 24, height: 900 })
  await a.setContent(
    `<body style="margin:0;display:flex;gap:24px;background:#888"><img src="data:image/png;base64,${left.toString('base64')}"><img src="data:image/png;base64,${right.toString('base64')}"></body>`,
  )
  await a.waitForTimeout(100)
  await a.screenshot({ path: join(out, 'vs-design-light-1440.png') })
  shots.push('vs-design-light-1440.png')
  await a.context().close()
}
await browser.close()

const atEnd = codeState()
const ok = Object.values(checks).every(Boolean) && errors.length === 0
writeFileSync(join(out, 'report.json'), JSON.stringify({ ok, ...atStart, ...(atEnd.commit !== atStart.commit ? { commitAtEnd: atEnd.commit } : {}), checks, errors, shots }, null, 1))
console.log(JSON.stringify({ ok, failed: Object.keys(checks).filter(k => !checks[k]), errors }, null, 1))
process.exit(ok ? 0 : 1)
