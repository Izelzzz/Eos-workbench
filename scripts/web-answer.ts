// 打开一个任务页，每出现一个待回答的问题，就在页面上回答：有选项点第一个，没有选项输入文字。直到任务结束。
// 每个问题截图两张（回答前、回答后），并记录问题与回答。
// 用法：node --import tsx scripts/web-answer.ts <base-url> <任务id> <输出目录> [最长分钟]
import { appendFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const [base = 'http://127.0.0.1:4317', id, out = '.eos/shots/answer', maxMin = '25'] = process.argv.slice(2)
if (id === undefined) throw new Error('需要任务 id')
mkdirSync(out, { recursive: true })
const log = join(out, 'answers.jsonl')

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errors: string[] = []
page.on('pageerror', (e: Error) => errors.push(e.message))
page.on('console', (m: any) => {
  if (m.type() === 'error') errors.push(m.text())
})
await page.goto(`${base}/#/tasks/${id}`)
await page.waitForSelector('.summary')

const until = Date.now() + Number(maxMin) * 60_000
let n = 0
while (Date.now() < until) {
  const status = await page.locator('.summary .pill').first().innerText()
  if (status === '已完成' || status === '失败' || status === '已中止') break
  const form = page.getByRole('form', { name: '回答提问' })
  if ((await form.count()) === 0) {
    await page.waitForTimeout(1000)
    continue
  }
  n++
  const question = await form.locator('.question-text').innerText()
  const options = await form.locator('.options button').allInnerTexts()
  await page.screenshot({ path: join(out, `q${n}-before.png`) })
  let answer: string
  if (options.length > 0) {
    answer = options[0]!
    await form.locator('.options button').first().click()
  } else {
    answer = '按你推荐的做'
    await form.locator('textarea').fill(answer)
    await form.getByRole('button', { name: '回答' }).click()
  }
  // 回答后表单应当消失（或换成下一个问题），页面显示"已回答"
  await page.waitForFunction((q: string) => !document.querySelector('.question-text') || document.querySelector('.question-text')!.textContent !== q, question, { timeout: 15_000 })
  const notice = await page
    .locator('.notice')
    .first()
    .innerText()
    .catch(() => '')
  await page.screenshot({ path: join(out, `q${n}-after.png`) })
  appendFileSync(log, `${JSON.stringify({ n, question, options, answer, notice })}\n`)
  console.log(JSON.stringify({ n, question, answer, notice }))
}
await page.screenshot({ path: join(out, 'final.png') })
console.log(JSON.stringify({ questions: n, final: await page.locator('.summary .pill').first().innerText(), errors }))
await browser.close()
