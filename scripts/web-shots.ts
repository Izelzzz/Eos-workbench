// 用 Playwright 打开 Eos Web，截图任务列表和任务详情（展开 trace、选中一个工具调用），并检查页面没有报错。
// 用法：node --import tsx scripts/web-shots.ts <base-url> <任务id> <输出目录> [scale]
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const [base = 'http://127.0.0.1:4317', id, out = '.eos/shots', scale = '1'] = process.argv.slice(2)
if (id === undefined) throw new Error('需要任务 id')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(scale) })
const errors: string[] = []
page.on('console', (m: any) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`) })
page.on('pageerror', (e: Error) => errors.push(`pageerror: ${e.message}`))

await page.goto(`${base}/#/`)
await page.waitForSelector('table.tasks tbody tr')
await page.screenshot({ path: join(out, '1-list.png') })

await page.goto(`${base}/#/tasks/${id}`)
await page.waitForSelector('.trace-row')
const collapsedRows = await page.locator('.trace-row').count()
await page.screenshot({ path: join(out, '2-detail.png') })

await page.getByRole('button', { name: '全部展开' }).click()
const allRows = await page.locator('.trace-row').count()
const tools = page.locator('.trace-row.kind-tool')
const toolCount = await tools.count()
const models = await page.locator('.trace-row.kind-model').count()
await tools.nth(Math.min(2, toolCount - 1)).click()
await page.waitForSelector('.detail .block pre')
const detailTitle = await page.locator('.detail-title h2').innerText()
const sections = await page.locator('.detail .block h3').allInnerTexts()
await page.screenshot({ path: join(out, '3-tool.png') })

await page.locator('.trace-row.kind-model').first().click()
await page.waitForSelector('.detail .block pre')
const modelSections = await page.locator('.detail .block h3').allInnerTexts()
await page.screenshot({ path: join(out, '4-model.png') })

const question = page.locator('.trace-row.kind-question').first()
if (await question.count() > 0) {
  await question.click()
  await page.screenshot({ path: join(out, '5-question.png') })
}
console.log(JSON.stringify({ collapsedRows, allRows, models, toolCount, detailTitle, sections, modelSections, errors }, null, 1))
await browser.close()
