// 改进页端到端验证（第 4 块 PR4）：真实模型跑任务，在浏览器里生成提案、看证据和对比、批准一条、拒绝一条。
// 1. 在 .eos/improve-web-e2e 建示例仓库，启动 eos web（先 npm run build:web）；团队规则只写进 reviewer 模板第 2 版（PR1 的场景）；
// 2. 并行跑 3 个 standard 任务，提问自动回答，失败自动重试；
// 3. 浏览器打开 #/improve，点「生成提案」（真实 improver），核对页面显示生成结果、列表里有提案；
// 4. 打开第一条：证据都链到任务、改动里有新增的行；填备注批准，核对页面提示和平台上的新版本；
// 5. 有第二条就打开：空理由拒绝被挡住，填理由后拒绝成功；
// 6. 1440 和 390 宽各截图，390 宽不横向滚动，页面没有脚本错误。结果写到 report.json。
// 用法：node --import tsx scripts/improve-web-e2e.ts [端口]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ProposalDetail, ProposalInfo, TaskDetail } from '../src/web/types.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'improve-web-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4334)
const base = `http://127.0.0.1:${port}`
const RULE = '\n  - 团队规则（必须执行）：每个导出的函数都要有 JSDoc 注释，并且包含 @example 用法示例；缺少的一律给出 changes（severity: major），在 issues 里写明哪个函数缺。\n'
const env = { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init'],
])
  execFileSync('git', a, { cwd: REPO })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T
const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })).json()

const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] })
const checks: Record<string, boolean> = {}
const facts: Record<string, unknown> = {}
try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base + '/api/tasks')
      break
    } catch {
      await sleep(500)
    }
  }
  const reviewer = await get<{ versions: { content: string }[] }>('/api/conventions/template/reviewer')
  const saved = (await post('/api/conventions/template/reviewer', { content: reviewer.versions[0]!.content.trimEnd() + RULE, note: 'E2E：团队规则只写在评审模板里' })) as {
    ok: boolean
    version?: number
  }
  if (!saved.ok || saved.version !== 2) throw new Error(`保存 reviewer 模板失败：${JSON.stringify(saved)}`)
  const ids: string[] = []
  for (const [file, fn, spec] of [
    ['sum', 'sum(numbers)', '返回数组的和，空数组返回 0'],
    ['max', 'max(numbers)', '返回最大值，空数组抛出 RangeError'],
    ['avg', 'avg(numbers)', '返回平均值，空数组返回 0'],
  ]) {
    const r = (await post('/api/tasks', {
      repo: REPO,
      workflow: 'standard',
      request: `在 src/${file}.js 里实现并导出 ${fn}：${spec}；为它写 node:test 测试放在 test/ 目录，\`npm test\` 必须通过。`,
    })) as { ok: boolean; id?: string; error?: string }
    if (!r.ok) throw new Error(`发起任务失败：${r.error}`)
    ids.push(r.id!)
  }
  const deadline = Date.now() + 40 * 60_000
  for (;;) {
    const ds = await Promise.all(ids.map(id => get<TaskDetail>(`/api/tasks/${id}`)))
    for (const d of ds) if (d.question !== undefined) await post(`/api/tasks/${d.id}/answer`, { questionId: d.question.id, text: d.question.options?.[0] ?? '按你的判断来' })
    for (const d of ds) if (d.status === 'failed') await post(`/api/tasks/${d.id}/retry`, {})
    if (ds.every(d => d.status === 'done' || d.status === 'aborted')) break
    if (Date.now() > deadline) throw new Error(`超时：${ds.map(d => `${d.id} ${d.status}`).join(', ')}`)
    await sleep(3000)
  }
  checks['3 个任务都完成'] = (await Promise.all(ids.map(id => get<TaskDetail>(`/api/tasks/${id}`)))).every(d => d.status === 'done')

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on('console', (m: any) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e: Error) => errors.push(e.message))
  const shot = (name: string) => page.screenshot({ path: join(OUT, name), fullPage: true })
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

  // 生成
  await page.goto(`${base}/#/improve`)
  await page.getByRole('button', { name: '生成提案' }).click()
  const status = page.locator('.generate [role=status], .generate [role=alert]')
  await status.waitFor({ timeout: 5 * 60_000 })
  facts.generateText = await status.innerText()
  checks['页面显示生成了待审批的提案'] = /生成了 [1-9]\d* 条待审批的提案/.test(String(facts.generateText))
  await page.waitForSelector('table.proposals tbody tr')
  const list = await get<ProposalInfo[]>('/api/improve/proposals')
  checks['列表里的提案数和接口一致'] = (await page.locator('table.proposals tbody tr').count()) === list.length && list.length > 0
  await shot('improve-list.png')

  // 第一条：证据、对比、批准
  const first = list.at(-1)!
  await page.goto(`${base}/#/improve/${first.id}`)
  await page.waitForSelector('.signals li')
  const detail = await get<ProposalDetail>(`/api/improve/proposals/${first.id}`)
  const links = await page.locator('.signals li .signal-head a').evaluateAll((as: any[]) => as.map(a => a.getAttribute('href')))
  checks['每条证据都显示出来并链到它的任务'] = detail.signals.length === first.evidence.length && JSON.stringify(links) === JSON.stringify(detail.signals.map(s => `#/tasks/${s.task}`))
  checks['改动里有新增的行'] = (await page.locator('.diff .diff-add').count()) > 0
  await shot('improve-detail.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.waitForSelector('.signals li')
  facts.overflowDetail390 = await overflow()
  await shot('improve-detail-390.png')
  await page.setViewportSize({ width: 1440, height: 900 })
  const before = (await get<{ versions: { version: number }[] }>(`/api/conventions/${first.target.kind}/${encodeURIComponent(first.target.name)}`)).versions[0]!.version
  await page.locator('label.decide textarea').fill('E2E：网页上批准')
  await page.getByRole('button', { name: '批准，写成新版本' }).click()
  await page.waitForSelector('.improve [role=status]')
  facts.approveText = await page.locator('.improve [role=status]').innerText()
  const after = (await get<{ versions: { version: number; note: string }[] }>(`/api/conventions/${first.target.kind}/${encodeURIComponent(first.target.name)}`)).versions[0]!
  checks['批准后页面提示新版本，平台上多了一个版本，备注写明提案号和审批备注'] =
    String(facts.approveText).includes(`现在是第 ${before + 1} 版`) && after.version === before + 1 && after.note.startsWith(`改进提案 #${first.id}：`) && after.note.endsWith('；E2E：网页上批准')
  checks['批准后状态显示已批准，审批按钮消失'] = (await page.locator('.summary-head .pill').innerText()) === '已批准' && (await page.getByRole('button', { name: '批准，写成新版本' }).count()) === 0
  await shot('improve-approved.png')

  // 第二条：拒绝
  const second = list.find(p => p.id !== first.id && p.target.name !== first.target.name) ?? list.find(p => p.id !== first.id)
  if (second !== undefined) {
    await page.goto(`${base}/#/improve/${second.id}`)
    await page.waitForSelector('.signals li')
    await page.getByRole('button', { name: '拒绝' }).click()
    checks['空理由拒绝被页面挡住'] =
      (await page.locator('.improve [role=alert]').innerText()) === '拒绝需要写理由。' && (await get<ProposalDetail>(`/api/improve/proposals/${second.id}`)).status === 'pending'
    await page.locator('label.decide textarea').fill('E2E：先只改一处，看效果再说')
    await page.getByRole('button', { name: '拒绝' }).click()
    await page.waitForSelector('.improve [role=status]')
    const d = await get<ProposalDetail>(`/api/improve/proposals/${second.id}`)
    checks['填理由后拒绝成功，记下理由'] = d.status === 'rejected' && d.events.at(-1)?.reason === 'E2E：先只改一处，看效果再说'
  } else facts.second = '只生成了一条提案，跳过拒绝'

  await page.goto(`${base}/#/improve`)
  await page.waitForSelector('table.proposals tbody tr')
  await shot('improve-list-after.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.waitForSelector('table.proposals tbody tr')
  facts.overflowList390 = await overflow()
  await shot('improve-list-390.png')
  await browser.close()
  checks['390 宽列表页和详情页都不横向滚动'] = facts.overflowList390 === 0 && facts.overflowDetail390 === 0
  checks['页面没有脚本错误'] = errors.length === 0
  facts.errors = errors
  facts.proposals = (await get<ProposalInfo[]>('/api/improve/proposals')).map(p => ({ id: p.id, target: p.target, status: p.status, rationale: p.rationale, evidence: p.evidence, events: p.events }))
  facts.tasks = ids
} finally {
  web.kill('SIGTERM')
}
// 记下跑的是哪一版代码：提交号，以及工作区有没有没提交的改动。
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'web/src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ commit, dirty, checks, facts }, null, 2))
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
