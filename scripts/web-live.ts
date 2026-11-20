// 打开一个运行中的任务页，不刷新页面，每隔一段时间截图并记录 trace 行数与状态，证明页面会自己更新。
// 用法：node --import tsx scripts/web-live.ts <base-url> <任务id> <输出目录> [间隔秒] [最长分钟]
import { appendFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const [base = 'http://127.0.0.1:4317', id, out = '.eos/shots/live', every = '30', maxMin = '25'] = process.argv.slice(2)
if (id === undefined) throw new Error('需要任务 id')
mkdirSync(out, { recursive: true })
const log = join(out, 'samples.jsonl')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
await page.goto(`${base}/#/tasks/${id}`)
await page.waitForSelector('.trace-row')
const until = Date.now() + Number(maxMin) * 60_000
for (let i = 1; Date.now() < until; i++) {
  await page.getByRole('button', { name: '全部展开' }).click()
  const sample = {
    i, at: new Date().toISOString().slice(11, 19),
    status: await page.locator('.summary .pill').first().innerText(),
    position: await page.locator('.stats div').nth(1).locator('b').innerText(),
    rows: await page.locator('.trace-row').count(),
    running: await page.locator('.trace-row .dot.running').count(),
    liveBars: await page.locator('.bar.live').count(),
  }
  appendFileSync(log, `${JSON.stringify(sample)}\n`)
  console.log(JSON.stringify(sample))
  await page.screenshot({ path: join(out, `live-${String(i).padStart(2, '0')}.png`) })
  if (sample.status === '已完成' || sample.status === '失败' || sample.status === '已中止') break
  await page.waitForTimeout(Number(every) * 1000)
}
await browser.close()
