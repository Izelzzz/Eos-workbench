// 导航（web/src/shell）的浏览器验证，不调用模型：用一个现成的数据目录启动 eos web，逐条核对导航和设置页的行为，
// 并把正式页面和设计稿 docs/design/nav.html 在同样的宽度、主题下并排截图。
// 用法：node --import tsx scripts/nav-web-e2e.ts <数据目录> <输出目录>（先 npm run build:web；数据目录可用 scripts/e2e-ci.ts 跑完后的 .eos/e2e/data）
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: (o?: unknown) => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const [src, out] = process.argv.slice(2)
if (src === undefined || out === undefined) throw new Error('用法：nav-web-e2e.ts <数据目录> <输出目录>')
mkdirSync(out, { recursive: true })

/** 跑的是哪份代码（和 scripts/e2e.ts 的 report.json 同样的字段，pr-checklist 用它核对证据对得上最终代码） */
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
const data = mkdtempSync(join(tmpdir(), 'eos-nav-'))
cpSync(src, data, { recursive: true })

let server: ChildProcess | undefined
process.on('exit', () => {
  server?.kill('SIGKILL')
  rmSync(data, { recursive: true, force: true })
})
const base = await new Promise<string>((resolve, reject) => {
  let output = ''
  const env: NodeJS.ProcessEnv = { ...process.env, DEEPSEEK_API_KEY: 'unused-in-this-script' }
  delete env.EOS_MASTER_KEY
  const p = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--port', '43918', '--data', data], { cwd: ROOT, env })
  server = p
  const on = (chunk: Buffer) => {
    output += chunk.toString()
    const m = /http:\/\/127\.0\.0\.1:\d+/.exec(output)
    if (m) resolve(m[0])
  }
  p.stdout.on('data', on)
  p.stderr.on('data', on)
  p.on('exit', c => reject(new Error(`eos web 退出了（${c}）：${output}`)))
})
const taskId = ((await (await fetch(`${base}/api/tasks`)).json()) as { id: string }[])[0]?.id
if (taskId === undefined) throw new Error('数据目录里没有任务')

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
  page.on('pageerror', (e: Error) => errors.push(`${width} ${scheme} pageerror: ${e.message}`))
  page.on('console', (m: any) => m.type() === 'error' && errors.push(`${width} ${scheme} console: ${m.text()}`))
  return page
}
const nav = (page: any) => page.getByRole('navigation', { name: '主导航' })
const current = async (page: any) => nav(page).locator('a[aria-current="page"]').getAttribute('aria-label')
const noHScroll = async (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
// 名字的浮层：看得见＝不透明且占位置（窄屏下 display: none）
const labelShown = async (link: any) => link.locator('span[aria-hidden="true"]').evaluate((s: HTMLElement) => getComputedStyle(s).display !== 'none' && Number(getComputedStyle(s).opacity) > 0.99)

const ROUTES: [string, string][] = [
  ['#/', '工作台'],
  ['#/tasks', '任务'],
  ['#/new', '任务'],
  [`#/tasks/${taskId}`, '任务'],
  ['#/chat', '对话'],
  ['#/insights', '统计'],
  ['#/improve', '改进'],
  ['#/conventions', '团队约定'],
  ['#/credentials', '设置'],
  ['#/forges', '设置'],
]

// ---- 宽屏 1440 ----
{
  const page = await open(1440)
  await page.goto(`${base}/#/`)
  await page.waitForSelector('main section')
  const names = await nav(page)
    .locator('a')
    .evaluateAll((as: Element[]) => as.map(a => a.getAttribute('aria-label')))
  check('宽屏：导航按顺序是 工作台、对话、任务、统计、改进、团队约定、设置', JSON.stringify(names) === JSON.stringify(['工作台', '对话', '任务', '统计', '改进', '团队约定', '设置']))
  const box = await nav(page).boundingBox()
  check('宽屏：导航是左边一条 56px 宽、和窗口一样高', box.x === 0 && box.width === 56 && box.height === 900)
  const settings = await nav(page).getByRole('link', { name: '设置' }).boundingBox()
  check('宽屏：「设置」在左下角', settings.y + settings.height > 900 - 30 && settings.x < 56)
  const texts = await nav(page)
    .locator('a')
    .evaluateAll((as: Element[]) => as.map(a => a.querySelector('svg') !== null))
  check('宽屏：每一项都是图标', texts.every(Boolean))
  for (const [hash, want] of ROUTES) {
    await page.goto(`${base}/${hash}`)
    await page.waitForSelector('main')
    await page.waitForTimeout(150)
    check(`宽屏：打开 ${hash} 时当前项是「${want}」`, (await current(page))?.split('，')[0] === want)
  }
  // 当前项有 fill-2 的底，其余没有底
  await page.goto(`${base}/#/insights`)
  await page.waitForSelector('main')
  await page.mouse.move(700, 450)
  await page.waitForTimeout(300) // 颜色有 150ms 的过渡
  const bg = await nav(page)
    .locator('a')
    .evaluateAll((as: HTMLElement[]) => as.map(a => getComputedStyle(a).backgroundColor))
  const fill2 = await page.evaluate(() => {
    const d = document.createElement('div')
    d.style.background = 'var(--fill-2)'
    document.body.append(d)
    const c = getComputedStyle(d).backgroundColor
    d.remove()
    return c
  })
  check('宽屏：当前项（统计）的底是 fill-2，其余透明', bg[3] === fill2 && bg.filter((c: string, i: number) => i !== 3).every((c: string) => c === 'rgba(0, 0, 0, 0)'))
  // 悬停和键盘聚焦显示名字
  const chat = nav(page).getByRole('link', { name: '对话' })
  check('宽屏：没悬停时不显示名字', !(await labelShown(chat)))
  await chat.hover()
  await page.waitForTimeout(250)
  check('宽屏：鼠标移到「对话」上显示名字', await labelShown(chat))
  await page.screenshot({ path: join(out, 'hover-light-1440.png'), clip: { x: 0, y: 0, width: 360, height: 320 } })
  await page.mouse.move(700, 450)
  // 重新载入，焦点从页面开头算起
  await page.reload()
  await page.waitForSelector('main')
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  await page.waitForTimeout(250)
  check('宽屏：Tab 第一下聚焦到导航的第一项（工作台），并显示名字', focused?.startsWith('工作台') === true && (await labelShown(nav(page).locator('a').first())))
  await page.screenshot({ path: join(out, 'focus-light-1440.png'), clip: { x: 0, y: 0, width: 360, height: 320 } })
  // 名字的浮层盖在页面内容上面（团队约定页左栏是 sticky，会形成层叠）
  await page.goto(`${base}/#/conventions`)
  await page.waitForSelector('main')
  const conv = nav(page).getByRole('link', { name: '团队约定' })
  await conv.hover()
  await page.waitForTimeout(250)
  // 浮层本身不接鼠标（pointer-events: none），查之前临时打开，看那一点最上面的是不是它
  const top = await conv.locator('span[aria-hidden="true"]').evaluate((s: HTMLElement) => {
    s.style.pointerEvents = 'auto'
    const r = s.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width - 3, r.top + r.height / 2) === s
    s.style.pointerEvents = ''
    return hit
  })
  check('宽屏：团队约定页上，名字的浮层不被左栏盖住', top)
  await page.screenshot({ path: join(out, 'hover-conventions-light-1440.png'), clip: { x: 0, y: 0, width: 480, height: 360 } })
  // 点导航能跳转
  await page.goto(`${base}/#/`)
  await page.waitForSelector('main')
  await nav(page).getByRole('link', { name: '团队约定' }).click()
  await page.waitForTimeout(200)
  check('宽屏：点「团队约定」跳到 #/conventions', page.url() === `${base}/#/conventions` && (await current(page)) === '团队约定')
  await page.context().close()
}

// ---- 设置页 ----
{
  const page = await open(1440)
  await page.goto(`${base}/#/credentials`)
  await page.waitForSelector('text=添加或替换')
  const tab = (name: string) => page.getByRole('tab', { name })
  check('设置：标题是「设置」', (await page.locator('main h1').first().textContent()) === '设置')
  check('设置：#/credentials 打开「凭据」一段', (await tab('凭据').getAttribute('aria-selected')) === 'true')
  await tab('代码托管').click()
  await page.waitForSelector('text=先注册一个 App')
  check('设置：点「代码托管」后地址变成 #/forges，显示代码托管的内容', page.url() === `${base}/#/forges` && (await tab('代码托管').getAttribute('aria-selected')) === 'true')
  await page.goBack()
  await page.waitForSelector('text=添加或替换')
  check('设置：浏览器后退回到「凭据」一段', page.url() === `${base}/#/credentials` && (await tab('凭据').getAttribute('aria-selected')) === 'true')
  await page.goto(`${base}/#/forges?error=${encodeURIComponent('测试用的错误')}`)
  await page.waitForSelector('text=注册没有完成：测试用的错误')
  check('设置：旧链接 #/forges?error=… 打开代码托管一段，显示结果（回调的地址不用改）', (await tab('代码托管').getAttribute('aria-selected')) === 'true')
  check('设置：结果显示后地址回到 #/forges', page.url() === `${base}/#/forges`)
  await page.goto(`${base}/#/new`)
  await page.locator('main a[href="#/credentials"]').click()
  await page.waitForSelector('text=添加或替换')
  check('设置：新建任务页里「凭据页」的链接打开设置的「凭据」一段', (await tab('凭据').getAttribute('aria-selected')) === 'true' && (await current(page)) === '设置')
  await page.context().close()
}

// ---- 窄屏 390 ----
{
  const page = await open(390)
  await page.goto(`${base}/#/`)
  await page.waitForSelector('main section')
  const box = await nav(page).boundingBox()
  check('窄屏：导航是顶上的一行', box.y === 0 && box.width === 390 && box.height < 60)
  const xs = await nav(page)
    .locator('a')
    .evaluateAll((as: Element[]) => as.map(a => a.getBoundingClientRect().right))
  check('窄屏：「设置」在最右边', Math.max(...xs) === xs.at(-1) && xs.at(-1)! > 390 - 30)
  const chat = nav(page).getByRole('link', { name: '对话' })
  await chat.hover()
  await page.waitForTimeout(250)
  check('窄屏：悬停不显示名字', !(await labelShown(chat)))
  for (const [hash, want] of ROUTES) {
    await page.goto(`${base}/${hash}`)
    await page.waitForSelector('main')
    await page.waitForTimeout(150)
    check(`窄屏：${hash} 当前项是「${want}」，页面不横向滚动`, (await current(page))?.split('，')[0] === want && (await noHScroll(page)))
  }
  await page.context().close()
}

// ---- 和设计稿并排 ----
const proto = `file://${join(ROOT, 'docs', 'design', 'nav.html')}`
const pairs: string[] = []
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    for (const [name, hash, protoItem] of [
      ['tasks', '#/tasks', '任务'],
      ['workbench', '#/', '工作台'],
      ['settings', '#/credentials', '设置'],
    ] as const) {
      const a = await open(width, scheme)
      await a.goto(proto)
      await a.waitForSelector('nav')
      await a
        .getByRole('navigation')
        .getByRole('link', protoItem === '工作台' ? { name: /^工作台/ } : { name: protoItem, exact: true })
        .click()
      await a.mouse.move(width - 5, 895)
      await a.waitForTimeout(250)
      const left: Buffer = await a.screenshot()
      await a.context().close()
      const b = await open(width, scheme)
      await b.goto(`${base}/${hash}`)
      await b.waitForSelector('main')
      await b.waitForLoadState('networkidle')
      await b.mouse.move(width - 5, 895)
      await b.waitForTimeout(250)
      const right: Buffer = await b.screenshot()
      await b.context().close()
      // 拼成一张：左边设计稿、右边正式页面
      const c = await open(width * 2 + 24, scheme)
      await c.setContent(
        `<body style="margin:0;display:flex;gap:24px;background:#888"><figure style="margin:0"><img src="data:image/png;base64,${left.toString('base64')}"></figure><figure style="margin:0"><img src="data:image/png;base64,${right.toString('base64')}"></figure></body>`,
      )
      await c.waitForTimeout(100)
      const file = `vs-design-${name}-${scheme}-${width}.png`
      await c.screenshot({ path: join(out, file), fullPage: true })
      await c.context().close()
      pairs.push(file)
    }
  }
}
await browser.close()

const atEnd = codeState()
const ok = Object.values(checks).every(Boolean) && errors.length === 0
writeFileSync(join(out, 'report.json'), JSON.stringify({ ok, ...atStart, ...(atEnd.commit !== atStart.commit ? { commitAtEnd: atEnd.commit } : {}), checks, errors, sideBySide: pairs }, null, 1))
console.log(JSON.stringify({ ok, failed: Object.keys(checks).filter(k => !checks[k]), errors }, null, 1))
process.exit(ok ? 0 : 1)
