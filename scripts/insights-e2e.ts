// 统计页端到端验证（第 3 块）：同一个平台上用真实模型跑几个任务，再打开统计页。
// 1. 在 .eos/insights-e2e 建示例仓库和全新的数据目录，启动 eos web；
// 2. 通过接口发起 standard（内置模板 spec-writer / developer / reviewer）和 feature 两种工作流的任务，提问一律自动回答；
// 3. 全部结束后在浏览器打开统计页截图，并核对：统计页的数字等于各任务详情页阶段数据之和；
// 4. 结果写到 report.json，截图在同一目录。
// 用法：NODE_PATH=<playwright 所在目录> node --import tsx scripts/insights-e2e.ts [端口]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { Insights } from '../src/engine/insights.ts'
import type { TaskDetail } from '../src/web/types.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'insights-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4330)
const base = `http://127.0.0.1:${port}`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init'],
])
  execFileSync('git', a, { cwd: REPO })

const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], {
  cwd: ROOT,
  env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T
const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })).json()

const REQUESTS: [string, string][] = [
  ['standard', '在 src/sum.js 里实现并导出 sum(numbers)：返回数组的和，空数组返回 0；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。'],
  ['standard', '在 src/max.js 里实现并导出 max(numbers)：返回最大值，空数组抛出 RangeError；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。'],
  ['feature', '在 src/avg.js 里实现并导出 avg(numbers)：返回平均值，空数组返回 0；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。'],
]

try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base + '/api/tasks')
      break
    } catch {
      await sleep(500)
    }
  }
  const ids: string[] = []
  for (const [workflow, request] of REQUESTS) {
    const r = (await post('/api/tasks', { repo: REPO, workflow, request })) as { ok: boolean; id?: string; error?: string }
    if (!r.ok) throw new Error(`发起任务失败：${r.error}`)
    ids.push(r.id!)
  }
  // 等全部结束；有提问就回答第一个选项（没有选项就答"按你的判断来"）。
  const deadline = Date.now() + 40 * 60_000
  for (;;) {
    const ds = await Promise.all(ids.map(id => get<TaskDetail>(`/api/tasks/${id}`)))
    for (const d of ds) if (d.question !== undefined) await post(`/api/tasks/${d.id}/answer`, { questionId: d.question.id, text: d.question.options?.[0] ?? '按你的判断来' })
    for (const d of ds) if (d.status === 'failed') await post(`/api/tasks/${d.id}/retry`, {})
    if (ds.every(d => d.status === 'done' || d.status === 'aborted')) break
    if (Date.now() > deadline) throw new Error(`超时：${ds.map(d => `${d.id} ${d.status}`).join(', ')}`)
    await sleep(3000)
  }

  const details = await Promise.all(ids.map(id => get<TaskDetail>(`/api/tasks/${id}`)))
  const ins = await get<Insights>('/api/insights')

  // 核对：统计页 = 各任务详情页之和
  const checks: Record<string, boolean> = {}
  const sumStage = (wf: string, node: string, k: 'wallMs' | 'agentMs' | 'calls') =>
    details.filter(d => d.workflow === wf).reduce((s, d) => s + (d.metrics.stages.find(x => x.node === node)?.[k] ?? 0), 0)
  checks['所有任务都完成'] = details.every(d => d.status === 'done')
  checks['任务数一致'] = ins.tasks.total === ids.length && ins.tasks.done === ids.length
  checks['每个阶段的时长、agent 时长、调用数等于各任务之和'] = ins.byStage.every(
    s => s.wallMs === sumStage(s.workflow, s.node, 'wallMs') && s.agentMs === sumStage(s.workflow, s.node, 'agentMs') && s.calls === sumStage(s.workflow, s.node, 'calls'),
  )
  checks['每个工作流的 token 等于各任务之和'] = ins.byWorkflow.every(w => w.usage.output === details.filter(d => d.workflow === w.workflow).reduce((s, d) => s + d.metrics.total.usage.output, 0))
  checks['按模板：standard 的三个内置模板都在，调用数等于各任务里这个角色的调用之和'] = ['spec-writer', 'developer', 'reviewer'].every(name => {
    const t = ins.byTemplate.find(x => x.name === name && x.template)
    const calls = details.reduce((s, d) => s + d.metrics.roles.filter(r => r.template?.name === name).reduce((a, r) => a + r.calls, 0), 0)
    return t !== undefined && t.calls === calls && calls > 0
  })
  checks['每个工作流都有瓶颈，且是它最耗时的阶段'] = ins.byWorkflow.every(w => {
    const b = ins.bottlenecks.find(x => x.workflow === w.workflow)
    const top = ins.byStage.filter(s => s.workflow === w.workflow)[0]
    return b !== undefined && top !== undefined && b.node === top.node
  })

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on('console', (m: any) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.goto(`${base}/#/insights`)
  await page.waitForSelector('.insights .bottlenecks')
  await page.screenshot({ path: join(OUT, 'insights.png'), fullPage: true })
  const bottleneckText = await page.$$eval('.bottlenecks li', (ls: any[]) => ls.map(l => l.innerText))
  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  await page.screenshot({ path: join(OUT, 'insights-390.png'), fullPage: true })
  await browser.close()
  checks['页面没有脚本错误'] = errors.length === 0
  checks['手机宽度页面不横向滚动'] = overflow === 0

  const report = {
    tasks: details.map(d => ({ id: d.id, workflow: d.workflow, status: d.status, calls: d.metrics.total.calls, wallMs: d.metrics.total.wallMs })),
    checks,
    bottleneckText,
    errors,
    insights: ins,
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
  console.log(bottleneckText.join('\n'))
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
} finally {
  web.kill('SIGTERM')
}
