// 第 4 块完整流程端到端验证（PR5，验收标准 ⑦）：一组任务 → 生成提案 → 批准 → 新任务用上新版本 → 对比页能看到两组。
// 1. 在 .eos/improve-full-e2e 建示例仓库，启动 eos web（先 npm run build:web）；团队规则（导出函数要有带 @example 的 JSDoc）只写进 reviewer 模板第 2 版；
// 2. 第一轮：并行跑 sum、max、avg 3 个 standard 任务（改进前）；
// 3. 通过接口生成提案（真实 improver），批准把 @example 规则写进 developer 模板（没有就用研发约定）的那一条；
// 4. 第二轮：同样 3 个需求再跑一遍（改进后）；
// 5. 核对：第二轮任务用的是新版本；对比接口里改进前、改进后各 3 个任务、样本足够；两组的评审轮次和证据条数等于直接从数据库独立复算的值；
//    统计页和提案页显示对比区，390 宽不横向滚动，没有脚本错误；
// 6. 结果（含两组的数字和提交号）写到 report.json，截图在同一目录。
// 用法：node --import tsx scripts/improve-full-e2e.ts [端口]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { GenerateResponse, ImprovementComparison, TaskDetail } from '../src/web/types.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'improve-full-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4335)
const base = `http://127.0.0.1:${port}`
const RULE = '\n  - 团队规则（必须执行）：每个导出的函数都要有 JSDoc 注释，并且包含 @example 用法示例；缺少的一律给出 changes（severity: major），在 issues 里写明哪个函数缺。\n'
const REQUESTS = [['sum', 'sum(numbers)', '返回数组的和，空数组返回 0'], ['max', 'max(numbers)', '返回最大值，空数组抛出 RangeError'], ['avg', 'avg(numbers)', '返回平均值，空数组返回 0']]
const env = { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T
const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })).json()

const round = async (): Promise<string[]> => {
  const ids: string[] = []
  for (const [file, fn, spec] of REQUESTS) {
    const r = await post('/api/tasks', { repo: REPO, workflow: 'standard', request: `在 src/${file}.js 里实现并导出 ${fn}：${spec}；为它写 node:test 测试放在 test/ 目录，\`npm test\` 必须通过。` }) as { ok: boolean; id?: string; error?: string }
    if (!r.ok) throw new Error(`发起任务失败：${r.error}`)
    ids.push(r.id!)
  }
  const deadline = Date.now() + 40 * 60_000
  for (;;) {
    const ds = await Promise.all(ids.map(id => get<TaskDetail>(`/api/tasks/${id}`)))
    for (const d of ds) if (d.question !== undefined) await post(`/api/tasks/${d.id}/answer`, { questionId: d.question.id, text: d.question.options?.[0] ?? '按你的判断来' })
    for (const d of ds) if (d.status === 'failed') await post(`/api/tasks/${d.id}/retry`, {})
    if (ds.every(d => d.status === 'done' || d.status === 'aborted')) return ids
    if (Date.now() > deadline) throw new Error(`超时：${ds.map(d => `${d.id} ${d.status}`).join(', ')}`)
    await sleep(3000)
  }
}

const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] })
const checks: Record<string, boolean> = {}
const facts: Record<string, unknown> = {}
try {
  for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/tasks'); break } catch { await sleep(500) } }
  const reviewer = await get<{ versions: { content: string }[] }>('/api/conventions/template/reviewer')
  const saved = await post('/api/conventions/template/reviewer', { content: reviewer.versions[0]!.content.trimEnd() + RULE, note: 'E2E：团队规则只写在评审模板里' }) as { ok: boolean; version?: number }
  if (!saved.ok || saved.version !== 2) throw new Error(`保存 reviewer 模板失败：${JSON.stringify(saved)}`)

  const before = await round()
  facts.before = before
  const gen = await post('/api/improve/generate', { workflow: 'standard', tasks: before }) as GenerateResponse
  if (!gen.ok) throw new Error(`生成提案失败：${gen.error}`)
  facts.generated = gen.created.map(p => ({ id: p.id, target: p.target, rationale: p.rationale, evidence: p.evidence }))
  facts.refused = gen.refused
  const chosen = gen.created.find(p => p.target.kind === 'template' && p.target.name === 'developer' && p.content.includes('@example'))
    ?? gen.created.find(p => p.target.kind === 'doc' && p.content.includes('@example'))
  checks['生成了把 @example 规则写进 developer 模板或约定文档的提案'] = chosen !== undefined
  if (chosen === undefined) throw new Error('没有可批准的提案')
  const approved = await post(`/api/improve/proposals/${chosen.id}/approve`, { note: 'E2E：完整流程' }) as { ok: boolean; proposal?: { events: { version?: number }[] }; error?: string }
  const version = approved.proposal?.events.at(-1)?.version
  checks['批准成功，生成了新版本'] = approved.ok && version === chosen.baseVersion + 1
  facts.approved = { id: chosen.id, target: chosen.target, version }

  const after = await round()
  facts.after = after

  // 第二轮任务用的是新版本（直接读数据库里的任务元数据）
  const db = new DatabaseSync(join(DATA, 'eos.db'), { readOnly: true })
  const meta = (id: string) => JSON.parse(String((db.prepare('SELECT meta FROM tasks WHERE id = ?').get(id) as { meta: string }).meta)) as { conventions?: { templates?: { name: string; version: number }[]; docs?: { name: string; version: number }[] } }
  const usedVersion = (id: string) => (chosen.target.kind === 'template' ? meta(id).conventions?.templates : meta(id).conventions?.docs)?.find(x => x.name === chosen.target.name)?.version
  checks['改进前的任务用旧版本，改进后的任务用新版本'] = before.every(id => usedVersion(id) === chosen.baseVersion) && after.every(id => usedVersion(id) === version)
  checks['6 个任务都完成'] = [...before, ...after].every(id => (db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string }).status === 'done')

  const list = await get<ImprovementComparison[]>('/api/improve/comparisons')
  const c = list.find(x => x.proposal.id === chosen.id)?.comparison
  checks['对比接口：改进前、改进后各 3 个任务，样本足够'] = c !== undefined && c.before.tasks === 3 && c.after.tasks === 3 && c.enough
  // 独立复算：直接从数据库里的任务状态数评审调用和没通过的检查结果。
  const raw = (ids: string[]) => {
    const per = ids.map(id => {
      const log = (JSON.parse(String((db.prepare('SELECT state FROM tasks WHERE id = ?').get(id) as { state: string }).state)) as { log: { type: string; purpose?: string; results?: { passed: boolean }[] }[] }).log
      return { reviews: log.filter(e => e.type === 'call' && e.purpose === 'critique').length, checkFailures: log.reduce((n, e) => n + (e.type === 'check' ? e.results!.filter(r => !r.passed).length : 0), 0) }
    })
    return { reviews: per.reduce((s, x) => s + x.reviews, 0) / ids.length, checkFailures: per.reduce((s, x) => s + x.checkFailures, 0) / ids.length, per }
  }
  const rb = raw(before)
  const ra = raw(after)
  db.close()
  checks['两组的评审轮次和检查失败等于从数据库独立复算的值'] = c !== undefined && Math.abs(c.before.mean.reviews - rb.reviews) < 1e-9 && Math.abs(c.after.mean.reviews - ra.reviews) < 1e-9
    && Math.abs(c.before.mean.checkFailures - rb.checkFailures) < 1e-9 && Math.abs(c.after.mean.checkFailures - ra.checkFailures) < 1e-9
  facts.raw = { before: rb, after: ra }
  facts.comparison = c === undefined ? undefined : { version: c.version, enough: c.enough, before: { tasks: c.before.tasks, done: c.before.done, mean: c.before.mean }, after: { tasks: c.after.tasks, done: c.after.done, mean: c.after.mean } }

  // 页面
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  page.on('pageerror', (e: Error) => errors.push(e.message))
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  await page.goto(`${base}/#/insights`)
  await page.waitForSelector('.compare-item table')
  const insightsRows = await page.locator('.compare-item table tbody tr').count()
  facts.insightsText = await page.locator('.compare-item').first().innerText()
  await page.locator('.compare-item').first().screenshot({ path: join(OUT, 'insights-compare.png') })
  await page.goto(`${base}/#/improve/${chosen.id}`)
  await page.waitForSelector('.compare table')
  await page.screenshot({ path: join(OUT, 'proposal-compare.png'), fullPage: true })
  checks['统计页和提案页都显示对比区（8 行：任务数、完成率、6 项指标），样本足够时有变化列、没有样本不足的提示'] = insightsRows === 8 && (await page.locator('.compare tbody tr').count()) === 8
    && (await page.locator('.compare .notice.warn').count()) === 0 && !/样本不足/.test(String(facts.insightsText))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  await page.waitForSelector('.compare table')
  facts.overflow390 = await overflow()
  await page.screenshot({ path: join(OUT, 'proposal-compare-390.png'), fullPage: true })
  await page.goto(`${base}/#/insights`)
  await page.waitForSelector('.compare-item table')
  facts.overflowInsights390 = await overflow()
  await browser.close()
  checks['390 宽提案页和统计页不横向滚动'] = facts.overflow390 === 0 && facts.overflowInsights390 === 0
  checks['页面没有脚本错误'] = errors.length === 0
  facts.errors = errors
} finally {
  web.kill('SIGTERM')
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'web/src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ commit, dirty, checks, facts }, null, 2))
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
const cmp = facts.comparison as { before: { mean: Record<string, number> }; after: { mean: Record<string, number> } } | undefined
if (cmp !== undefined) console.log(`评审轮次 ${cmp.before.mean.reviews!.toFixed(2)} → ${cmp.after.mean.reviews!.toFixed(2)}，证据条数 ${cmp.before.mean.signals!.toFixed(2)} → ${cmp.after.mean.signals!.toFixed(2)}，token ${Math.round(cmp.before.mean.tokens!)} → ${Math.round(cmp.after.mean.tokens!)}`)
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
