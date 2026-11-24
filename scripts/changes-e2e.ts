// 试用反馈第 4 条的端到端验证：任务页显示仓库、分支、worktree，「改动」区列出改动的文件和每个文件的 diff。
// 真实模型、内置 standard 工作流。启动 eos web，页面上新建任务，agent 提问时在页面上回答，等任务结束，
// 再在任务页展开改动的文件截图（桌面 1440 宽和手机 390 宽）。页面上显示的文件和增删行数与 git 的结果逐个比对，写进 report.json。
// 用法：node --import tsx scripts/changes-e2e.ts [端口]
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Playwright 用环境里预装的那份，不装进项目依赖。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'changes-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4331)
const base = `http://127.0.0.1:${port}`
const REQUEST = '在 src/clamp.js 实现并导出 clamp(value, min, max)：把数字限制在 [min, max] 之间；min 大于 max 时抛 RangeError。用 node:test 写测试放在 test/ 目录，npm test 必须通过。README.md 不用改。'

const note = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  appendFileSync(join(OUT, 'steps.log'), `${line}\n`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
writeFileSync(join(REPO, 'README.md'), '# demo\n')
for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })

const startServer = async (): Promise<ChildProcess> => {
  const out = openSync(join(OUT, 'server.log'), 'a')
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

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
execFileSync('npm', ['run', 'build:web'], { cwd: ROOT, stdio: 'ignore' })
const server = await startServer()
note(`eos web 已启动（提交 ${commit}）`)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errors: string[] = []
page.on('pageerror', (e: Error) => errors.push(e.message))
page.on('console', (m: any) => { if (m.type() === 'error') errors.push(m.text()) })

try {
  await page.goto(`${base}/#/new`)
  await page.getByRole('form', { name: '新建任务' }).waitFor()
  await page.getByPlaceholder(/path\/to\/your\/repo/).fill(REPO)
  await page.locator('.new-task select').selectOption('standard')
  await page.locator('.new-task textarea').fill(REQUEST)
  await page.getByRole('button', { name: '创建并开始' }).click()
  await page.waitForURL(/#\/tasks\/t\w+/)
  const id = /#\/tasks\/(t\w+)/.exec(page.url())![1]!
  note(`页面上创建了任务 ${id}`)

  const answers: string[] = []
  let status = ''
  const until = Date.now() + 40 * 60_000
  while (Date.now() < until) {
    const form = page.getByRole('form', { name: '回答提问' })
    if (await form.count() > 0) {
      const q = await form.locator('.question-text').innerText()
      const option = form.locator('.options button').first()
      if (await option.count() > 0) {
        answers.push(`${q} → ${await option.innerText()}`)
        await option.click()
      } else {
        answers.push(`${q} → 按你的判断做`)
        await form.locator('textarea').fill('按你的判断做')
        await form.getByRole('button', { name: '回答' }).click()
      }
      note(`页面回答：${answers.at(-1)!.slice(0, 160)}`)
      await page.waitForFunction((text: string) => document.querySelector('.question-text')?.textContent !== text, q, { timeout: 15_000 }).catch(() => {})
      continue
    }
    const d = (await (await fetch(`${base}/api/tasks/${id}`)).json()) as { status: string }
    if (d.status !== status) note(`状态：${(status = d.status)}`)
    if (d.status === 'done' || d.status === 'failed' || d.status === 'aborted') break
    await sleep(3000)
  }

  // 任务页：仓库信息和改动区。
  await page.reload()
  const changes = page.getByRole('region', { name: '改动' })
  await changes.locator('.change-file').first().waitFor({ timeout: 30_000 })
  const where = Object.fromEntries(await page.locator('.where dt').evaluateAll((dts: Element[]) => dts.map(dt => [dt.textContent, dt.nextElementSibling?.textContent])))
  const rows: { status: string; path: string; count: string }[] = await changes.locator('.change-file').evaluateAll((bs: Element[]) =>
    bs.map(b => ({ status: b.querySelector('.change-status')!.textContent!, path: b.querySelector('.change-path')!.textContent!, count: b.querySelector('.change-count')!.textContent! })))
  // 展开第一个源码文件的 diff（没有就展开第一个）。
  const target = rows.findIndex(r => r.path.startsWith('src/'))
  await changes.locator('.change-file').nth(Math.max(0, target)).click()
  const diffBox = changes.locator('pre.diff').first()
  await diffBox.waitFor()
  const diffText = await diffBox.innerText()
  await diffBox.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(OUT, '1-task-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await changes.locator('.change-file').nth(Math.max(0, target)).click()
  await changes.locator('pre.diff').first().waitFor()
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  await page.screenshot({ path: join(OUT, '2-task-390.png'), fullPage: true })

  // 和 git 逐个比对：基线到任务分支的 numstat。
  const detail = (await (await fetch(`${base}/api/tasks/${id}`)).json()) as { repo: string; branch: string; worktree: string; baseSha: string }
  const numstat = execFileSync('git', ['diff', '--numstat', detail.baseSha, detail.branch], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(l => l !== '')
    .map(l => { const [a, d, p] = l.split('\t'); return { path: p!, count: `+${a} -${d}` } })
  const shown = rows.map(r => ({ path: r.path, count: r.count.replace(/\s+/g, ' ').trim() }))
  const gitFile = execFileSync('git', ['diff', detail.baseSha, detail.branch, '--', rows[Math.max(0, target)]!.path], { cwd: REPO, encoding: 'utf8' })
  const report = {
    commit, task: id, status, answers,
    checks: {
      '任务完成': status === 'done',
      '页面显示仓库、分支、worktree、基线': where['仓库'] === detail.repo && where['分支'] === detail.branch && where['工作目录（worktree）'] === detail.worktree && where['基线提交'] === detail.baseSha.slice(0, 12),
      '改动区的文件和增删行数与 git numstat 一致': JSON.stringify([...shown].sort((a, b) => a.path.localeCompare(b.path))) === JSON.stringify([...numstat].sort((a, b) => a.path.localeCompare(b.path))),
      '展开的 diff 和 git diff 的内容一致': gitFile.slice(gitFile.search(/^@@/m)).trim().split('\n').every(l => diffText.includes(l.trim())),
      '390 宽没有横向滚动': overflow <= 0,
      '页面没有报错': errors.length === 0,
    },
    where, rows, numstat, errors,
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  const passed = Object.values(report.checks).filter(Boolean).length
  note(`${passed}/${Object.keys(report.checks).length} 通过`)
  for (const [k, v] of Object.entries(report.checks)) note(`${v ? '✓' : '✗'} ${k}`)
} finally {
  await browser.close()
  process.kill(-server.pid!, 'SIGTERM')
}
