// 组件样张和用户认可的设计稿并排截图，给用户确认「像不像」。
// 先跑 scripts/web-ui-gallery.ts 得到样张截图（gallery-<亮暗>-<宽>.png），再跑这个脚本：
//   node --import tsx scripts/web-ui-vs-design.ts <样张截图目录> <输出目录>
// 设计稿是 docs/design/workbench.html（不依赖仓库代码的网页）。按亮色、暗色和 1440 宽各截一张，
// 和同样配色的样张截图按原大小左右拼在一起，输出 vs-design-<亮暗>.png；另把 390 宽的样张原样放在一起。
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const [shots, out] = process.argv.slice(2)
if (shots === undefined || out === undefined) throw new Error('用法：web-ui-vs-design.ts <样张截图目录> <输出目录>')
mkdirSync(out, { recursive: true })
const design = pathToFileURL(join(ROOT, 'docs', 'design', 'workbench.html')).href

const browser = await chromium.launch()
for (const scheme of ['light', 'dark'] as const) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme })
  await page.goto(design)
  // 设计稿会从 Google Fonts 取 Inter；取不到时用系统字体，和网页一致
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(500)
  const designShot: Buffer = await page.screenshot()
  const gallery = readFileSync(join(shots, `gallery-${scheme}-1440.png`))
  // 左边设计稿、右边样张，都按原大小（1:1）放，只取第一屏的高度；上面一行写明哪边是哪边
  const img = (b: Buffer) => `<img style="display:block;width:1440px;height:900px;object-fit:cover;object-position:top" src="data:image/png;base64,${b.toString('base64')}">`
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888;font:14px system-ui">
    <div style="display:flex;gap:16px;padding:8px">
      <div><div style="color:#fff;padding:4px 0">设计稿（docs/design/workbench.html）</div>${img(designShot)}</div>
      <div><div style="color:#fff;padding:4px 0">组件样张（scripts/ui-gallery），第一屏</div>${img(gallery)}</div>
    </div></body>`
  const board = await browser.newPage({ viewport: { width: 2912, height: 950 } })
  await board.setContent(html)
  await board.screenshot({ path: join(out, `vs-design-${scheme}.png`), fullPage: true })
  await board.close()
  await page.close()
  copyFileSync(join(shots, `gallery-${scheme}-390.png`), join(out, `gallery-${scheme}-390.png`))
}
await browser.close()
console.log(`并排截图写到了 ${out}`)
