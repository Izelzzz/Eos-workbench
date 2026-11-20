// Web 端到端验证（M2c）：全程只用浏览器操作。
// 1. 启动 eos web；浏览器打开首页 → 新建任务（填仓库、写需求）→ 跳到任务页；
// 2. agent 提问时在页面上点第一个选项回答；
// 3. 开发那一步进行中时，把 Web 服务整个进程组 SIGKILL（模拟机器掉电），页面应显示"连接不上服务"并自动重试；
// 4. 重新启动 eos web，它应自动续跑这个任务，页面自己恢复，直到任务完成；
// 5. 从存储里核对结果，写 report.json，截图在同一目录。
// 用法：NODE_PATH=<playwright 所在目录> node --import tsx scripts/web-e2e.ts [端口]
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'web-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4320)
const base = `http://127.0.0.1:${port}`
const REQUEST = '在 src/slugify.js 实现并导出 slugify(text)：把标题转换成适合放进 URL 的短字符串，用 node:test 写测试，npm test 必须通过。中文、emoji 和长度上限怎么处理我还没想好，有不确定、而且会影响实现的地方先问我。'

const note = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  appendFileSync(join(OUT, 'steps.log'), `${line}\n`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(REPO), { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })

/** 启动 eos web，作为独立进程组，方便整个组一起杀掉（连同它启动的 dsh 子进程）。 */
const startServer = async (n: number): Promise<ChildProcess> => {
  const out = openSync(join(OUT, `server-${n}.log`), 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)],
    { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' } })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/tasks`)).ok) return child
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  throw new Error('eos web 没有启动')
}

let server = await startServer(1)
note(`eos web 已启动（pid ${server.pid}）`)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errors: string[] = []
page.on('pageerror', (e: Error) => errors.push(e.message))
let shot = 0
const snap = async (name: string) => page.screenshot({ path: join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`) })

await page.goto(`${base}/#/`)
await page.getByRole('link', { name: '新建任务' }).click()
await page.getByRole('form', { name: '新建任务' }).waitFor()
await page.getByPlaceholder(/path\/to\/your\/repo/).fill(REPO)
await page.locator('.new-task textarea').fill(REQUEST)
await snap('new-task')
await page.getByRole('button', { name: '创建并开始' }).click()
await page.waitForURL(/#\/tasks\/t\w+/)
const id = /#\/tasks\/(t\w+)/.exec(page.url())![1]!
note(`页面上创建了任务 ${id}`)

const detail = async () => (await (await fetch(`${base}/api/tasks/${id}`)).json()) as { status: string; position: string; runnerAlive: boolean }
let killed = false
let answered = 0
const until = Date.now() + 25 * 60_000
while (Date.now() < until) {
  const form = page.getByRole('form', { name: '回答提问' })
  if (await form.count() > 0 && await form.locator('.options button').count() > 0) {
    const q = await form.locator('.question-text').innerText()
    if (answered === 0) await snap('question')
    const choice = await form.locator('.options button').first().innerText()
    await form.locator('.options button').first().click()
    answered++
    note(`页面回答 #${answered}：${q} → ${choice}`)
    await page.waitForFunction((text: string) => document.querySelector('.question-text')?.textContent !== text, q, { timeout: 15_000 }).catch(() => {})
    continue
  }
  let d: Awaited<ReturnType<typeof detail>> | undefined
  try {
    d = await detail()
  } catch {
    d = undefined
  }
  if (d?.status === 'done' || d?.status === 'failed' || d?.status === 'aborted') break
  if (!killed && d?.position === 'build') {
    await sleep(4000) // 让开发跑一会儿，确保是"进行中"被杀
    killed = true
    note(`开发进行中，SIGKILL 整个 eos web 进程组（pgid ${server.pid}）`)
    process.kill(-server.pid!, 'SIGKILL')
    await page.waitForSelector('text=连接不上服务', { timeout: 20_000 })
    await snap('server-down')
    server = await startServer(2)
    note(`eos web 重新启动（pid ${server.pid}）`)
    await page.waitForFunction(() => !document.body.textContent?.includes('连接不上服务'), undefined, { timeout: 30_000 })
    await snap('resumed')
  }
  await sleep(1500)
}
await page.waitForSelector('.summary .pill.ok', { timeout: 60_000 }).catch(() => {})
await page.getByRole('button', { name: '全部展开' }).click()
await snap('done')
await browser.close()
process.kill(-server.pid!, 'SIGTERM')

const store = new Store(join(DATA, 'eos.db'))
const task = store.get(id)!
const events = store.events(id)
const calls = task.log.filter(e => e.type === 'call').map(e => (e.type === 'call' ? e.call : ''))
const meta = store.meta(id)
const npmTest = (() => {
  try {
    execFileSync('npm', ['test'], { cwd: meta.worktree, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const serverLog2 = (() => {
  try {
    return execFileSync('cat', [join(OUT, 'server-2.log')], { encoding: 'utf8' })
  } catch {
    return ''
  }
})()
const checks = {
  '任务在页面上创建（created 由 web 发出）': events[0]?.actor === 'web',
  '提问全部在页面上回答（answered 都由 web 发出）': answered > 0 && events.filter(e => e.event.kind === 'answered' && e.accepted).every(e => e.actor === 'web'),
  'Web 服务被杀时开发正在进行': killed,
  '重启后自动续跑这个任务': serverLog2.includes(`接着运行上次没跑完的任务：${id}`),
  '任务完成': task.status === 'done',
  '已完成的调用没有重复': new Set(calls).size === calls.length,
  'worktree 里 npm test 通过': npmTest,
  '页面没有脚本错误': errors.length === 0,
}
const report = { task: id, answered, calls: task.log.filter(e => e.type === 'call').map(e => (e.type === 'call' ? `${e.call} ${e.purpose}@${e.node} ${e.ms}ms` : '')), checks, errors }
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
