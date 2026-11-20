// 第 2 块 T4 的浏览器验证：在真实浏览器里走一遍「新建 Agent 模板 / 技能 → 看中文错误 → 改好保存 → 看历史和 diff」，
// 再看任务页上用到的模板和技能版本，最后看手机宽度下有没有横向滚动。截图写到 docs/e2e/b2/ui/。
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Page } from 'playwright'

// playwright 不在仓库的依赖里（只用来跑这个验证）。装在别处时用 NODE_PATH 指过去，例如
// NODE_PATH=/opt/node-tools/node_modules node --import tsx docs/e2e/b2/ui/ui-e2e.ts
const { chromium } = createRequire(import.meta.url)('playwright') as typeof import('playwright')

const SHOTS = import.meta.dirname
const BASE = process.env.EOS_E2E_BASE ?? 'http://127.0.0.1:4417'

const BAD_TEMPLATE = `name: auditor
description: 审计：独立核对改动是否满足规格，只读
model: deepseek-flash
write: none
writePaths: [src/**]
tools:
  deny: [网络]
skills: [audit-notes]
prompt: 你是审计员，不要修改任何文件。
`

const GOOD_TEMPLATE = `name: auditor
description: 审计：独立核对改动是否满足规格，只读
model: deepseek-flash
effort: high
write: none
tools:
  deny: [subagent, schedule]
skills: [audit-notes]
prompt: |
  你是独立的审计员，只核对，不修改任何文件。
  - 逐条对照规格里的验收标准，给出结论和证据。
`

const GOOD_SKILL = `---
name: audit-notes
description: 写审计结论时使用：团队约定的审计结论格式
---
# 审计结论的写法

逐条写：核对了什么、结论（通过/不通过）、证据（命令和输出）。
`

const AUDIT_WORKFLOW = `name: audit
description: 审计：一个只读的 agent 核对改动
roles:
  checker: { template: auditor }
nodes:
  - { id: build, kind: agent, role: checker, task: 核对改动是否满足规格。 }
`

const shot = async (page: Page, name: string) => {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
  console.log(`截图 ${name}.png`)
}

/** 填编辑器并等「边写边校验」出结果（检查中… → 格式正确 / 错误列表）。 */
const type = async (page: Page, content: string) => {
  await page.getByRole('textbox', { name: /内容$/ }).fill(content)
  await page.waitForFunction(() => {
    const el = document.querySelector('.conv-check')
    return el !== null && el.textContent !== '' && !el.textContent!.includes('检查中')
  }, undefined, { timeout: 10_000 })
}

const text = (page: Page, selector: string) => page.locator(selector).innerText()

const main = async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
  const fails: string[] = []
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}`)
    if (!ok) fails.push(what)
  }

  // 1. 四栏侧栏和新的介绍
  await page.goto(`${BASE}/#/conventions`)
  await page.waitForSelector('.conv-group')
  const groups = await page.locator('.conv-group-head b').allInnerTexts()
  check(groups.join(',') === '工作流,约定文档,Agent 模板,技能', `侧栏四栏：${groups.join('、')}`)
  const side = await text(page, '.conv-side')
  check(/developer[\s\S]*可写 worktree/.test(side), '模板那栏显示可写范围')
  check(side.includes('write-changes'), '技能那栏列出 write-changes')
  await shot(page, '01-四栏与介绍')

  // 2. 新建技能：先看正文为空的中文错误，再保存
  await page.goto(`${BASE}/#/conventions/new/skill`)
  await page.waitForSelector('.conv-editor')
  check((await text(page, '.conv-main')).includes('技能的名字取开头'), '新建技能有中文说明')
  check((await page.inputValue('.conv-editor')).startsWith('---\nname: my-skill'), '技能起始文本是合法的 frontmatter')
  await shot(page, '02-新建技能的起始文本')
  await type(page, GOOD_SKILL.replace(/# 审计结论[\s\S]*$/, ''))
  const skillErr = await text(page, '.conv-errors')
  check(skillErr.includes('(正文)') && skillErr.includes('技能正文不能为空'), `技能错误带位置：${skillErr.replace(/\n/g, ' ')}`)
  await shot(page, '03-技能的中文错误带位置')
  await type(page, GOOD_SKILL)
  check((await text(page, '.conv-check')).includes('格式正确'), '改好后提示格式正确')
  await page.getByRole('textbox', { name: '修改说明' }).fill('初版：审计结论的格式')
  await page.getByRole('button', { name: '保存为新版本' }).click()
  // 新建保存成功后页面跳到这个约定自己的地址（编辑器重新挂载，所以这里看标题而不是提示条）。
  await page.waitForSelector('.conv-history')
  check((await page.evaluate(() => location.hash)) === '#/conventions/skill/audit-notes', '保存后跳到这个技能的页面')
  check((await text(page, '.conv-title')).includes('技能 · 当前第 1 版'), '技能保存成第 1 版')
  check((await text(page, '.conv-side')).includes('审计结论'), '侧栏立刻出现新技能和它的说明')
  await shot(page, '04-技能已保存')

  // 3. 新建 Agent 模板：起始文本、两处中文错误（枚举 + 只读不能写 writePaths）、改好保存
  await page.goto(`${BASE}/#/conventions/new/template`)
  await page.waitForSelector('.conv-editor')
  const starter = await page.inputValue('.conv-editor')
  check(/tools:\n  # deny 列出不给这个 agent 的工具组/.test(starter), '模板起始文本带 tools.deny 的中文注释')
  check(starter.includes('# writePaths 限制可以改哪些文件'), '模板起始文本带 writePaths 的中文注释')
  await shot(page, '05-新建模板的起始文本')
  // 字段本身的错误（枚举）和字段之间的错误（只读却给了 writePaths、技能不存在）分别看：
  // 解析器先报字段错误，字段都合法了才报字段之间的错误，所以不会同时出现。
  await type(page, BAD_TEMPLATE)
  const enumErr = await page.locator('.conv-errors li').allInnerTexts()
  check(enumErr.length === 1 && enumErr[0]!.startsWith('tools.deny[0]') && enumErr[0]!.includes('只能是 web、subagent、bash、schedule、todo、goal 之一'), `工具组写错：${enumErr.join(' / ')}`)
  check(await page.getByRole('button', { name: '保存为新版本' }).isDisabled(), '有错误时保存按钮不可点')
  await shot(page, '06-模板的中文错误带位置-工具组')
  await type(page, BAD_TEMPLATE.replace('deny: [网络]', 'deny: [subagent]'))
  const crossErr = await page.locator('.conv-errors li').allInnerTexts()
  check(crossErr.some(e => e.startsWith('writePaths') && e.includes('只读（write: none）的角色不需要 writePaths')), `只读却给了 writePaths：${crossErr.join(' / ')}`)
  await shot(page, '06b-模板的中文错误带位置-只读与可写范围')
  await type(page, BAD_TEMPLATE.replace('deny: [网络]', 'deny: [subagent]').replace('writePaths: [src/**]\n', '').replace('skills: [audit-notes]', 'skills: [nope]'))
  const missing = await page.locator('.conv-errors li').allInnerTexts()
  check(missing.some(e => e.startsWith('skills[0]') && e.includes('平台上没有名为「nope」的技能')), `引用了不存在的技能：${missing.join(' / ')}`)
  await shot(page, '06c-模板的中文错误带位置-技能不存在')
  await type(page, GOOD_TEMPLATE)
  check((await text(page, '.conv-check')).includes('格式正确'), '改好后提示格式正确')
  await page.getByRole('textbox', { name: '修改说明' }).fill('初版：只读的审计员')
  await page.getByRole('button', { name: '保存为新版本' }).click()
  await page.waitForSelector('.conv-history')
  check((await page.evaluate(() => location.hash)) === '#/conventions/template/auditor', '保存后跳到这个模板的页面')
  await shot(page, '07-模板已保存')

  // 4. 改第 2 版：先看未保存的改动，再保存后看历史里的折叠 diff
  await type(page, GOOD_TEMPLATE.replace('deny: [subagent, schedule]', 'deny: [subagent, schedule, web]'))
  check((await text(page, '.conv-pending')).includes('未保存的改动（相对第 1 版）'), '未保存的改动有 diff')
  await shot(page, '08-未保存的改动')
  await page.getByRole('textbox', { name: '修改说明' }).fill('也不给联网')
  await page.getByRole('button', { name: '保存为新版本' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.conv-history li').length === 2)
  const history = await text(page, '.conv-history')
  check(history.includes('第 2 版') && history.includes('也不给联网') && history.includes('初版：只读的审计员'), '历史里两版都在，带说明')
  const diff = await text(page, '.diff')
  check(diff.includes('+ ') && diff.includes('省略'), `diff 折叠了未改动的行：${diff.split('\n').find(l => l.includes('省略')) ?? ''}`)
  await shot(page, '09-历史版本与折叠 diff')
  await page.locator('.conv-history button.link').last().click()
  await shot(page, '10-看第一版的改动')

  // 5. 工作流用这个模板当角色（T1 的 role: { template: … }），为任务页准备数据
  await page.goto(`${BASE}/#/conventions/new/workflow`)
  await page.waitForSelector('.conv-editor')
  await type(page, AUDIT_WORKFLOW)
  check((await text(page, '.conv-check')).includes('格式正确'), '工作流可以用 template 引用模板')
  await page.getByRole('button', { name: '保存为新版本' }).click()
  await page.waitForSelector('.conv-history')

  // 6. 任务页：显示创建时用到的模板和技能版本（直接写 store，不调用模型）
  console.log(execFileSync(process.execPath, ['--import', 'tsx', `${SHOTS}/seed-task.ts`], { encoding: 'utf8' }).trim())
  await page.goto(`${BASE}/#/tasks/demo-1`)
  await page.waitForSelector('.stats')
  const stats = await text(page, '.stats')
  check(/Agent 模板\nauditor · 第 2 版/.test(stats), `任务页显示模板版本：${stats.split('\n').slice(0, 12).join(' | ')}`)
  check(/技能\naudit-notes · 第 1 版/.test(stats), '任务页显示技能版本')
  await shot(page, '11-任务页用到的约定版本')
  await page.locator('.stats a', { hasText: 'auditor' }).click()
  await page.waitForSelector('.conv-history')
  check((await page.evaluate(() => location.hash)) === '#/conventions/template/auditor', '任务页的模板链接能点到模板页')

  // 7. 手机宽度 390：不能有横向滚动
  await page.setViewportSize({ width: 390, height: 844 })
  for (const [name, hash] of [['12-手机宽度-约定首页', '#/conventions'], ['13-手机宽度-模板页', '#/conventions/template/auditor'], ['14-手机宽度-任务页', '#/tasks/demo-1']] as const) {
    await page.goto(`${BASE}/${hash}`)
    await page.waitForSelector(hash.startsWith('#/tasks') ? '.stats' : '.conv-group')
    const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }))
    check(over.doc <= over.win, `${name}：没有横向滚动（内容宽 ${over.doc}，窗口宽 ${over.win}）`)
    await shot(page, name)
  }

  await browser.close()
  console.log(fails.length === 0 ? `\n全部通过` : `\n失败 ${fails.length} 项：\n${fails.join('\n')}`)
  process.exitCode = fails.length === 0 ? 0 : 1
}

await main()
