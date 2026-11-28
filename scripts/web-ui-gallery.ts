// 基础组件的浏览器验证：构建 scripts/ui-gallery（样式和网页相同），在 Chromium 里按亮色、暗色和 1440、390 宽截图，并核对：
// - 组件的样式真的生效（键盘聚焦有外框、主按钮是主色底、输入框有边框、表单控件用页面字体、现有页面的 button 规则没有盖过组件）；
// - 390 宽不横向滚动；
// - 选项、下拉菜单、分段切换的点击和键盘操作；任务行的高度和窄屏下隐藏进度；
// - 对话框：点开后焦点在对话框里，Esc 关闭并把焦点还给触发按钮；点「删除」执行并关闭；
// - 页面没有脚本错误。
// 结果写到 <输出目录>/gallery-report.json（不叫 report.json：那是 scripts/e2e.ts 的报告格式，CI 的 pr-checklist 按它核对）。用法：node --import tsx scripts/web-ui-gallery.ts <输出目录>
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
// 在写任何输出之前记下代码状态（输出目录在仓库里时，截图本身会算成未提交的改动）
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const uncommitted = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
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
      return { ink: s.getPropertyValue('--ink').trim(), line: s.getPropertyValue('--line').trim(), surface: s.getPropertyValue('--surface').trim() }
    })
    const toRgb = (hex: string) => {
      // 压缩后的 CSS 会把 #ffffff 写成 #fff
      const h = hex.replace('#', '')
      const n = Number.parseInt(h.length === 3 ? [...h].map(c => c + c).join('') : h, 16)
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
    }
    const primary = page.getByRole('button', { name: '保存', exact: true })
    check(`${tag}：主按钮的底色是令牌 --ink`, (await style(primary, 'background-color')) === toRgb(vars.ink))
    check(`${tag}：主按钮高 36px（组件样式盖过了现有页面的 button 规则）`, (await style(primary, 'height')) === '36px')
    check(`${tag}：输入框的边框是令牌 --line`, (await style(page.locator('#g-name'), 'border-top-color')) === toRgb(vars.line))
    check(
      `${tag}：卡片底色是令牌 --surface、没有边框、有阴影`,
      (await style(page.locator('[data-slot=card]').first(), 'background-color')) === toRgb(vars.surface) &&
        (await style(page.locator('[data-slot=card]').first(), 'border-top-width')) === '0px' &&
        (await style(page.locator('[data-slot=card]').first(), 'box-shadow')) !== 'none',
    )
    const bodyFont = await style(page.locator('body'), 'font-family')
    check(
      `${tag}：输入框、多行输入框、下拉、按钮用页面字体（不是浏览器默认的表单字体）`,
      (await Promise.all(['#g-name', '#g-req', '#g-flow', '[data-slot=button]'].map(s => style(page.locator(s).first(), 'font-family')))).every(f => f === bodyFont),
    )
    // 键盘聚焦时画出 2px 墨色外框
    // 表单里最后一个输入框之后就是「稍后」按钮
    await page.locator('#g-req').focus()
    await page.keyboard.press('Tab')
    // 按钮的颜色过渡 150ms（外框颜色也在里面），等它走完再读
    await page.waitForTimeout(300)
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement
      const st = getComputedStyle(el)
      return { style: st.outlineStyle, width: st.outlineWidth, offset: st.outlineOffset, color: st.outlineColor, ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() }
    })
    check(`${tag}：键盘聚焦的按钮有 2px 墨色外框、离元素 2px`, focused.style === 'solid' && focused.width === '2px' && focused.offset === '2px' && focused.color === toRgb(focused.ink))
    // 截图前移开焦点，免得截图里的按钮带着聚焦外框
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    for (const id of ['#bare-ghost', '#bare-link']) {
      check(`${tag}：页面底色上的 ${id.slice(1)} 按钮没有底色（现有 button 规则的底色没漏进来）`, (await style(page.locator(id), 'background-color')) === 'rgba(0, 0, 0, 0)')
    }
    check(`${tag}：输入框字号：窄屏 16px（iOS 不放大），宽屏 14px`, (await style(page.locator('#g-name'), 'font-size')) === (width < 640 ? '16px' : '14px'))
    check(`${tag}：不横向滚动`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    await page.screenshot({ path: join(out, `gallery-${scheme}-${width}.png`), fullPage: true })

    const taskRow = page.locator('[data-slot=task-row] > div > *').first()
    check(`${tag}：任务行高 44px`, (await style(taskRow, 'height')) === '44px')
    const progressShown = (await style(page.locator('[data-slot=task-row] > div > * > span[aria-hidden]').first(), 'display')) !== 'none'
    check(`${tag}：任务行的进度${width < 640 ? '在窄屏下隐藏' : '显示'}`, progressShown === width >= 640)
    // 分隔线和清单同宽，悬停的那一行比清单左右各宽 12px；鼠标移上去时这一行上下的线隐去
    const list = await page.locator('[data-slot=task-list]').first().boundingBox()
    const second = page.locator('[data-slot=task-row]').nth(1)
    const li = await second.boundingBox()
    const inner = await second.locator('> div > *').boundingBox()
    check(`${tag}：任务行的分隔线和清单同宽，行的悬停底色左右各宽 12px`, li.x === list.x && li.width === list.width && inner.x === list.x - 12 && inner.width === list.width + 24)
    if (width >= 640) {
      await page.locator('[data-slot=task-row]').nth(2).hover()
      await page.waitForTimeout(300)
      const third = await style(page.locator('[data-slot=task-row]').nth(2), 'border-top-color')
      const fourth = await style(page.locator('[data-slot=task-row]').nth(3), 'border-top-color')
      check(`${tag}：悬停的那一行上下的分隔线隐去`, third === 'rgba(0, 0, 0, 0)' && fourth === 'rgba(0, 0, 0, 0)')
      await page.mouse.move(0, 0)
    }

    if (scheme === 'light') {
      // 选项：点击选中，选中的是墨色边框和实心的勾；键盘下键选下一个
      const options = page.locator('[data-slot=option]')
      await options.nth(1).click()
      await page.waitForTimeout(300) // 边框颜色有 150ms 的过渡
      const secondOption = page.locator('input[name=scope]').nth(1)
      check(`${tag}：点选项能选中`, await secondOption.isChecked())
      check(
        `${tag}：选中的选项是墨色边框、勾是墨色实心`,
        (await style(options.nth(1), 'border-top-color')) === toRgb(vars.ink) && (await style(options.nth(1).locator('span[aria-hidden]'), 'background-color')) === toRgb(vars.ink),
      )
      await secondOption.focus()
      await page.keyboard.press('ArrowDown')
      check(`${tag}：键盘下键选中下一个选项`, await page.locator('input[name=scope]').nth(2).isChecked())

      // 「其他」和选项只能有一个答案
      const other = page.getByRole('textbox', { name: '其他' })
      await other.fill('只导出最近 30 天')
      check(`${tag}：在「其他」里输入后，已选的选项取消`, (await page.locator('input[name=scope]:checked').count()) === 0)
      await options.nth(0).click()
      check(`${tag}：再选一个选项，「其他」清空`, (await other.inputValue()) === '' && (await page.locator('input[name=scope]').nth(0).isChecked()))

      // 下拉菜单：点开有 4 项，Esc 关闭并把焦点还给触发按钮
      const menuTrigger = page.getByRole('button', { name: /1 \/ 3/ })
      await menuTrigger.click()
      const menu = page.getByRole('menu')
      await menu.waitFor()
      check(`${tag}：下拉菜单打开，有 4 项`, (await menu.getByRole('menuitem').count()) === 4)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'hidden' })
      check(`${tag}：Esc 关闭下拉菜单，焦点回到触发按钮`, await menuTrigger.evaluate((b: Element) => b === document.activeElement))

      // 分段切换：点「改动」切过去，键盘左键切回「过程」
      const diffTab = page.getByRole('tab', { name: '改动' })
      await diffTab.click()
      check(`${tag}：点「改动」切换过去`, (await diffTab.getAttribute('aria-selected')) === 'true' && (await page.locator('[data-slot=note]').isVisible()))
      await page.keyboard.press('ArrowLeft')
      await page.keyboard.press('Enter')
      check(`${tag}：键盘左键切回「过程」`, (await page.getByRole('tab', { name: '过程' }).getAttribute('aria-selected')) === 'true')
      const trigger = page.getByRole('button', { name: '删除凭据' })
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '删除 github.com 的令牌？' })
      await dialog.waitFor()
      check(`${tag}：对话框打开后焦点在对话框里`, await dialog.evaluate((d: Element) => d.contains(document.activeElement)))
      check(`${tag}：对话框两边至少留 16px`, await dialog.evaluate((d: Element) => d.getBoundingClientRect().left >= 16 && d.getBoundingClientRect().right <= window.innerWidth - 16))
      const close = dialog.getByRole('button', { name: '关闭' })
      check(`${tag}：右上角关闭按钮 28×28、没有内边距（现有 button 规则的内边距没漏进来）`, (await style(close, 'padding-left')) === '0px' && (await style(close, 'width')) === '28px')
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

const passed = Object.values(checks).filter(Boolean).length
writeFileSync(join(out, 'gallery-report.json'), JSON.stringify({ commit, uncommitted, checks, errors }, null, 1))
console.log(`\n${passed}/${Object.keys(checks).length} 项通过。报告：${join(out, 'gallery-report.json')}`)
process.exit(passed === Object.keys(checks).length ? 0 : 1)
