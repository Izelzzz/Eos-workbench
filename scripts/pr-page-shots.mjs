// 任务页截图：「链接」一栏（分支、PR），以及改动很大时改动区提示到 PR 页面看 diff。
// 用法：先用 `npm run eos -- web --port 4396 --data <E2E 的数据目录>` 起服务，再运行
//   node scripts/pr-page-shots.mjs http://127.0.0.1:4396 <任务id> <输出目录>
// 改动区的提示要 20 个文件以上才出现：这里把改动接口的返回换成 25 个文件来触发，再用真实接口确认小改动不提示。
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Playwright 用环境里预装的那份，不装进项目依赖。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const [base, id, dir] = process.argv.slice(2)
const b = await chromium.launch()
const errors = []
const page = async () => {
  const p = await b.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  p.on('pageerror', e => errors.push(e.message))
  return p
}

const p1 = await page()
await p1.goto(`${base}/#/tasks/${id}`)
await p1.waitForSelector('dl.where')
const links = await p1.locator('dl.where a').evaluateAll(as => as.map(a => [a.textContent, a.href]))
await p1.locator('dl.where').screenshot({ path: join(dir, 'task-links.png') })

const p2 = await page()
await p2.route(`**/api/tasks/${id}/changes`, r =>
  r.fulfill({
    json: { base: '86149f886082aaaa', head: 'f'.repeat(40), omitted: 0, files: Array.from({ length: 25 }, (_, i) => ({ path: `src/f${i}.js`, status: 'added', add: 10, del: 0, binary: false })) },
  }),
)
await p2.goto(`${base}/#/tasks/${id}`)
await p2.waitForSelector('section.changes .change-files')
const notice = await p2
  .locator('section.changes .notice')
  .innerText()
  .catch(() => '')
const href = await p2
  .locator('section.changes .notice a')
  .getAttribute('href')
  .catch(() => null)
await p2.locator('section.changes').screenshot({ path: join(dir, 'large-changes.png') })

const p3 = await page()
await p3.goto(`${base}/#/tasks/${id}`)
await p3.waitForSelector('section.changes .change-files')
const smallNotice = await p3.locator('section.changes .notice').count()

console.log(JSON.stringify({ links, notice, href, smallNotice, errors }, null, 1))
await b.close()
