// 基础组件的浏览器验证：构建 scripts/ui-gallery（样式和网页相同），在 Chromium 里按亮色、暗色和 1440、390 宽截图，并核对：
// - 组件的样式真的生效（主按钮是主色底、输入框有边框、表单控件用页面字体、现有页面的 button 规则没有盖过组件）；
// - 390 宽不横向滚动；
// - 对话框：点开后焦点在对话框里，Esc 关闭并把焦点还给触发按钮；点「删除」执行并关闭；
// - 页面没有脚本错误。
// 结果写到 <输出目录>/report.json。用法：node --import tsx scripts/web-ui-gallery.ts <输出目录>
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { build, preview } from 'vite'

// Playwright 用环境里预装的那份（NODE_PATH 指向它），不装进项目依赖，所以这里不做类型检查。
const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const out = process.argv[2] ?? join(ROOT, '.eos', 'ui-gallery')
const dist = join(ROOT, '.eos', 'ui-gallery-dist')
mkdirSync(out, { recursive: true })

const config = { root: join(import.meta.dirname, 'ui-gallery'), plugins: [react(), tailwindcss()], logLevel: 'warn' as const, build: { outDir: dist, emptyOutDir: true } }
await build(config)
const server = await preview({ ...config, preview: { port: 0, host: '127.0.0.1' } })
const base = server.resolvedUrls?.local[0]
if (base === undefined) throw new Error('预览服务没有地址')

const checks: Record<string, boolean> = {}
const check = (name: string, ok: boolean) => {
  checks[name] = ok
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}
const errors: string[] = []
const browser = await chromium.launch()
for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme })
    page.on('console', (m: any) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${scheme} ${width} ${m.type()}: ${m.text()}`)
    })
    page.on('pageerror', (e: Error) => errors.push(`${scheme} ${width} pageerror: ${e.message}`))
    await page.goto(base)
    await page.getByRole('button', { name: '保存', exact: true }).waitFor()
    const tag = `${scheme} ${width}`
    const style = (sel: any, prop: string) => sel.evaluate((el: Element, p: string) => getComputedStyle(el).getPropertyValue(p), prop)
    const vars = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement)
      return { running: s.getPropertyValue('--running').trim(), line: s.getPropertyValue('--line').trim(), panel: s.getPropertyValue('--panel').trim() }
    })
    const toRgb = (hex: string) => {
      // 压缩后的 CSS 会把 #ffffff 写成 #fff
      const h = hex.replace('#', '')
      const n = Number.parseInt(h.length === 3 ? [...h].map(c => c + c).join('') : h, 16)
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
    }
    const primary = page.getByRole('button', { name: '保存', exact: true })
    check(`${tag}：主按钮的底色是令牌 --running`, (await style(primary, 'background-color')) === toRgb(vars.running))
    check(`${tag}：主按钮高 32px（组件样式盖过了现有页面的 button 规则）`, (await style(primary, 'height')) === '32px')
    check(`${tag}：输入框的边框是令牌 --line`, (await style(page.locator('#g-name'), 'border-top-color')) === toRgb(vars.line))
    check(`${tag}：面板底色是令牌 --panel`, (await style(page.locator('[data-slot=card]').first(), 'background-color')) === toRgb(vars.panel))
    const bodyFont = await style(page.locator('body'), 'font-family')
    check(
      `${tag}：输入框、多行输入框、下拉、按钮用页面字体（不是浏览器默认的表单字体）`,
      (await Promise.all(['#g-name', '#g-req', '#g-flow', '[data-slot=button]'].map(s => style(page.locator(s).first(), 'font-family')))).every(f => f === bodyFont),
    )
    check(`${tag}：不横向滚动`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.screenshot({ path: join(out, `gallery-${scheme}-${width}.png`), fullPage: true })

    if (scheme === 'light') {
      const trigger = page.getByRole('button', { name: '删除凭据' })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '删除 github.com 的令牌？' })
      await dialog.waitFor()
      check(`${tag}：对话框打开后焦点在对话框里`, await dialog.evaluate((d: Element) => d.contains(document.activeElement)))
      check(`${tag}：对话框不超出屏幕`, await dialog.evaluate((d: Element) => d.getBoundingClientRect().right <= window.innerWidth && d.getBoundingClientRect().left >= 0))
      await page.screenshot({ path: join(out, `dialog-${width}.png`) })
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      check(`${tag}：Esc 关闭对话框，焦点回到触发按钮`, await trigger.evaluate((b: Element) => b === document.activeElement))
      await trigger.click()
      await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
      check(`${tag}：点「删除」执行并关闭`, (await page.locator('#confirmed').innerText()) === '已确认 1 次')
    }
    await page.close()
  }
}
await browser.close()
await new Promise<void>(r => server.httpServer.close(() => r()))
check('页面没有脚本错误', errors.length === 0)

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const uncommitted = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
const passed = Object.values(checks).filter(Boolean).length
writeFileSync(join(out, 'report.json'), JSON.stringify({ commit, uncommitted, checks, errors }, null, 1))
console.log(`\n${passed}/${Object.keys(checks).length} 项通过。报告：${join(out, 'report.json')}`)
process.exit(passed === Object.keys(checks).length ? 0 : 1)
