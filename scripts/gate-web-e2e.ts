// 卡点的网页验证（路线图 5b）：真实的 Web 服务、Supervisor、git worktree 和浏览器，agent 用不调模型的假执行器。
// 1. 建一个示例仓库，工作流是「规划 → 开发 → 评审 → 人验收的卡点」；假开发每次回复都在 worktree 里改 src/math.js（平台提交）；
// 2. 任务停在卡点上后，浏览器打开任务列表（能看出、能筛出等验收的任务）和任务页（卡点面板、被验收的产出、改动）；
// 3. 在页面上不写意见点「打回修改」（应提示要写意见），写意见后打回；改完回到卡点（第 2 次）后在页面上点「通过」，任务完成；
// 4. 390 宽度下打开列表和任务页，核对没有横向滚动；
// 4b. 修正（路线图 5c）：任务完成后在页面上提交一条补充，交给开发；改完任务回到完成，修正记录显示第几次、内容和改到的文件；
// 5. 从存储里核对结果，写 gate-web-report.json，截图在同一目录。
// 用法：node --import tsx scripts/gate-web-e2e.ts [输出目录]
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Conventions } from '../src/conventions/conventions.ts'
import { Credentials } from '../src/credentials/store.ts'
import type { Executor, Reply } from '../src/executor/types.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { createWebServer } from '../src/web/server.ts'

// Playwright 用环境里预装的那份，不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const [out = join(ROOT, '.eos', 'gate-web')] = process.argv.slice(2)
const WORK = join(ROOT, '.eos', 'gate-web-work')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const REPO = join(WORK, 'repo')
mkdirSync(join(REPO, 'src'), { recursive: true })
writeFileSync(join(REPO, 'src', 'math.js'), '// 数学工具函数\n')
const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO })
git('init', '-q', '-b', 'main')
git('add', '-A')
git('-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init')

const WORKFLOW = `name: gate-web
roles:
  planner: { prompt: 你负责写方案 }
  developer: { prompt: 你负责开发, write: worktree }
  reviewer: { prompt: 你负责评审 }
nodes:
  - { id: plan, kind: agent, role: planner, task: 写方案 }
  - { id: build, kind: agent, role: developer, task: 按方案实现, inputs: [plan] }
  - { id: review, kind: dialog, role: reviewer, with: build, maxRounds: 1, task: 评审, inputs: [plan] }
  - { id: accept, kind: gate, with: build, by: human, task: 人验收：确认 sum 的实现和注释都清楚。 }
`
const SEND_BACK = '请在 sum 上方补一段 JSDoc 注释，写明参数、返回值和会抛出的错误。'
const PASS = '```json\n{"verdict":"pass","summary":"实现正确","issues":[]}\n```'
const V1 = 'export function sum(xs) {\n  return xs.reduce((a, b) => a + b, 0)\n}\n'
const V2 = `/**\n * 求和。\n * @param {number[]} xs 数字数组\n * @returns {number} 总和，空数组返回 0\n */\n${V1}`

const store = new Store(join(WORK, 'eos.db'))
let id = ''
let devTurns = 0
/** 假执行器：开发每次回复都改 worktree 里的 src/math.js（第一次实现，之后按意见补注释），评审给 pass，其余回一句话。 */
const executor: Executor = {
  async send(p): Promise<Reply> {
    let text = '方案：在 src/math.js 实现 sum。'
    if (p.key.endsWith('/build')) {
      devTurns++
      if (devTurns <= 2) writeFileSync(join(store.meta(id).worktree, 'src', 'math.js'), devTurns === 1 ? V1 : V2)
      else writeFileSync(join(store.meta(id).worktree, 'README.md'), '# 示例\n\n`sum([1, 2, 3])` 返回 6。\n')
      text = devTurns === 1 ? '实现了 sum。' : devTurns === 2 ? '按验收意见在 sum 上方补了 JSDoc 注释。' : '按修正在 README.md 里补了用法示例。'
    } else if (p.key.endsWith('/review')) text = PASS
    return { sessionId: `s:${p.key}`, text, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, ms: 20, model: 'fake' }
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
const supervisor = new Supervisor({ store, executor, dataDir: WORK, actor: 'web', pollMs: 50 })
const saved = new Conventions(store).save({ kind: 'workflow', name: 'gate-web', content: WORKFLOW, actor: 'e2e' }, Date.now())
if (!saved.ok) throw new Error(JSON.stringify(saved))
const created = await supervisor.create({ repo: REPO, workflow: 'gate-web', request: '在 src/math.js 实现 sum：求一个数字数组的总和。' })
if (!created.ok) throw new Error(created.error)
id = created.id
// 另一个任务（没有卡点，只建不跑，列表里显示运行中），列表里应能和等验收的任务区分开。
const other = await supervisor.create({ repo: REPO, workflow: 'feature', request: '一个不用验收的任务（示意）' })
if (!other.ok) throw new Error(other.error)
// 凭据存储不带主密钥（这里用不到凭据）。
const credentials = new Credentials(join(WORK, 'eos.db'), undefined)
const server = createWebServer({ store, supervisor, replay: executor, staticDir: join(ROOT, 'web', 'dist'), credentials })
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
supervisor.start(id)

const until = async (what: string, ok: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`等不到：${what}（任务 ${store.get(id)?.status}）`)
    await new Promise(r => setTimeout(r, 50))
  }
}
await until('停在卡点上', () => store.get(id)?.status === 'waiting_accept')

const browser = await chromium.launch()
const errors: string[] = []
const open = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 })
  page.on('console', (m: any) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))
  return page
}
const overflow = (page: any): Promise<{ scrollWidth: number; innerWidth: number }> => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }))
const shot = (page: any, name: string) => page.screenshot({ path: join(out, name), fullPage: true })

const page = await open(1280)
await page.goto(`${base}/#/tasks`)
await page.waitForSelector('table.tasks tbody tr')
const listBanner = await page.locator('.gate-filter span').innerText()
const awaitingRows = await page.locator('tr.awaiting').count()
await shot(page, '1-list.png')
await page.getByRole('button', { name: '只看等验收的' }).click()
const filteredRows = await page.locator('table.tasks tbody tr').count()
await shot(page, '2-list-filtered.png')

await page.goto(`${base}/#/tasks/${id}`)
await page.waitForSelector('section.gate')
const gateText = await page.locator('section.gate').innerText()
const changed = await page
  .locator('section.changes')
  .getByText('src/math.js')
  .first()
  .waitFor({ timeout: 10_000 })
  .then(
    () => true,
    () => false,
  )
await shot(page, '3-gate-round1.png')
// 不写意见就打回：页面提示要写意见，任务不变。
await page.getByRole('button', { name: '打回修改' }).click()
const emptyError = await page.locator('section.gate .error').innerText()
await page.getByLabel('验收意见').fill(SEND_BACK)
await page.getByRole('button', { name: '打回修改' }).click()
await until('打回、改完回到卡点（第 2 次）', () => store.get(id)?.status === 'waiting_accept' && store.get(id)?.gate?.round === 2)
// 第几次在打回时就加一，修改进行中页面也显示第 2 次：等面板回到「等待验收」（有意见框）再读。
await page.waitForSelector('section.gate.waiting textarea')
const round2Text = await page.locator('section.gate').innerText()
await shot(page, '4-gate-round2.png')

const narrow = await open(390)
await narrow.goto(`${base}/#/tasks`)
await narrow.waitForSelector('table.tasks tbody tr')
const narrowList = await overflow(narrow)
await shot(narrow, '5-list-390.png')
await narrow.goto(`${base}/#/tasks/${id}`)
await narrow.waitForSelector('section.gate textarea')
const narrowTask = await overflow(narrow)
await narrow.locator('section.gate').screenshot({ path: join(out, '6-gate-390.png') })
await shot(narrow, '7-task-390.png')

// 另一个标签页开着「只看等验收的」：任务被通过之后（没有等验收的了），还要能切回显示全部。
const filtered = await open(1280)
await filtered.goto(`${base}/#/tasks`)
await filtered.getByRole('button', { name: '只看等验收的' }).click()
await page.getByRole('button', { name: '通过' }).click()
await until('通过后任务完成', () => store.get(id)?.status === 'done')
await page.waitForSelector('text=已完成')
await shot(page, '8-done.png')
// 列表每 5 秒刷新一次：等到刷新后没有等验收的任务，再看切换按钮还在不在。
await filtered.waitForSelector('tr.awaiting', { state: 'detached', timeout: 15_000 })
const toggleLeft = await filtered.getByRole('button', { name: '显示全部' }).isVisible()
await filtered.getByRole('button', { name: '显示全部' }).click()
const allBack = await filtered.locator('table.tasks tbody tr').count()
await shot(filtered, '9-list-filter-after-accept.png')

// 修正：任务完成后在页面上提交一条补充（默认交给最后一个 agent 节点 build），改完任务回到完成。
const CORRECTION = '补充：在 README.md 里写一段 sum 的用法示例。'
const sessionBefore = store.get(id)!.sessions.build
await page.getByLabel('改正或补充').fill(CORRECTION)
await page.getByRole('button', { name: '提交修正' }).click()
await until('修正完成', () => store.get(id)?.status === 'done' && store.get(id)!.log.some(e => e.type === 'note' && e.text === '第 1 次修正完成'))
await page.waitForSelector('section.corrections li .pill.ok')
await page.waitForSelector('section.corrections >> text=README.md')
const correctionText = await page.locator('section.corrections').innerText()
await page.locator('section.corrections').screenshot({ path: join(out, '10-correction.png') })
const narrowDone = await open(390)
await narrowDone.goto(`${base}/#/tasks/${id}`)
await narrowDone.waitForSelector('section.corrections li')
const narrowCorrection = await overflow(narrowDone)
await narrowDone.locator('section.corrections').screenshot({ path: join(out, '11-correction-390.png') })
await browser.close()
await supervisor.idle()

const task = store.get(id)!
const decisions = task.log.flatMap(e => (e.type === 'decision' ? [[e.round, e.by, e.pass, e.comment]] : []))
const actors = store
  .events(id)
  .filter(e => e.event.kind === 'decided')
  .map(e => [e.actor, e.accepted])
const committed = execFileSync('git', ['show', `${store.meta(id).branch}:src/math.js`], { cwd: REPO, encoding: 'utf8' })
const checks = {
  '列表能看出等验收的任务（提示条、行标记），能筛出只看等验收的': /1 个任务在等验收/.test(listBanner) && awaitingRows === 1 && filteredRows === 1,
  '任务页显示卡点：第几次、验收对象和验收人、被验收的产出': /第 1 次验收/.test(gateText) && /验收「build」，验收人：任何能访问平台的人/.test(gateText) && gateText.includes('实现了 sum。'),
  任务页的改动里有被验收的文件: changed,
  '不写意见打回：页面提示要写意见': /打回时要写明意见/.test(emptyError),
  '页面上打回后交回开发修改，改完回到卡点（第 2 次），页面显示打回记录和新的产出': /第 2 次验收/.test(round2Text) && round2Text.includes(SEND_BACK) && round2Text.includes('按验收意见'),
  页面上通过后任务完成: task.status === 'done',
  '结论来自网页（actor 是 web），先打回后通过':
    JSON.stringify(actors) ===
      JSON.stringify([
        ['web', true],
        ['web', true],
      ]) &&
    JSON.stringify(decisions) ===
      JSON.stringify([
        [1, 'human', false, SEND_BACK],
        [2, 'human', true, ''],
      ]),
  修改提交到了任务分支: committed.includes('@param'),
  '390 宽度：任务列表没有横向滚动': narrowList.scrollWidth <= narrowList.innerWidth,
  '390 宽度：任务页没有横向滚动': narrowTask.scrollWidth <= narrowTask.innerWidth,
  '筛选打开时任务被通过（没有等验收的了）：还能切回显示全部': toggleLeft && allBack === 2,
  '页面上提交修正：交给 build 原来的会话，改完回到完成；修正记录显示第几次、交给谁、内容、完成、改到的文件':
    /第 1 次修正/.test(correctionText) &&
    correctionText.includes('交给「build」') &&
    correctionText.includes(CORRECTION) &&
    correctionText.includes('完成') &&
    correctionText.includes('改动的文件：README.md') &&
    task.sessions.build === sessionBefore &&
    JSON.stringify(
      store
        .events(id)
        .filter(e => e.event.kind === 'corrected')
        .map(e => [e.actor, e.accepted]),
    ) === JSON.stringify([['web', true]]),
  '390 宽度：有修正记录的任务页没有横向滚动': narrowCorrection.scrollWidth <= narrowCorrection.innerWidth,
  页面没有报错: errors.length === 0,
}
const commit = (() => {
  try {
    const g = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
    return { commit: g('rev-parse', 'HEAD'), uncommitted: g('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean) }
  } catch {
    return {}
  }
})()
const report = {
  ...commit,
  task: id,
  checks,
  round2Text,
  correctionText,
  narrowCorrection,
  narrowList,
  narrowTask,
  errors,
  calls: task.log.flatMap(e => (e.type === 'call' ? [`${e.call} ${e.purpose}@${e.node}`] : [])),
}
writeFileSync(join(out, 'gate-web-report.json'), JSON.stringify(report, null, 2))
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
server.close()
store.close()
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
