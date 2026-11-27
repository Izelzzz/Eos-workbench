// 对话页的端到端验证（网页）：真实的 eos web、dsh、平台 MCP 端点，在浏览器里新建对话请 agent 设计一个工作流，看差异、确认权限后保存。
// 核对：
// - 导航里有「对话」；发出去之后、回复完成之前，页面上已经出现 agent 读了什么（按步推送）；
// - 回复完成后跳到这个对话，记录里有这一轮的回复和读了哪些数据；
// - 提议显示差异（新建显示全文）和醒目的权限警告；没勾确认之前「保存」按钮不可用，勾上之后保存成第 1 版，操作人 web，备注写明来源和确认了的权限；
// - 保存后提议显示「已保存」、不再有保存按钮；保存之前约定表一行都没变；
// - 历史对话列表里有这个对话；在对话里接着说一句，记录变成 4 条；
// - 1440 和 390 宽截图，390 宽不横向滚动，页面没有脚本错误；平台持有的模型 key 不在页面和对话记录里。
// 用法：node --import tsx scripts/chat-web-e2e.ts [--fake] [端口]
//   --fake：用假模型（不花钱，本地联调）。不加就是真实模型，报告和截图写进 docs/e2e/chat-b/。先 npm run build:web。
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PROPOSE_TOOL } from '../src/chat/proposals.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { Store } from '../src/store/store.ts'
import { startFakeModel } from './fake-model/server.ts'
import type { Reply, Request } from './fake-model/script.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const fake = process.argv.includes('--fake')
const port = Number(process.argv.find(a => /^\d+$/.test(a)) ?? 4341)
const base = `http://127.0.0.1:${port}`
const OUT = join(ROOT, '.eos', 'chat-web-e2e')
const DATA = join(OUT, 'data')
const SHOTS = fake ? OUT : join(ROOT, 'docs', 'e2e', 'chat-b')
const KEY = fake ? 'fake-model-key-0123456789' : (process.env.DEEPSEEK_API_KEY ?? 'proxy-injected')
const ASK =
  '帮我设计一个新的工作流，名字叫 review-only：只有两个阶段，先由 spec-writer 模板写规格，再由 reviewer 模板评审规格，评审不通过最多来回 3 轮。参考平台上现有的 standard 工作流的写法。设计好了用提议工具提交。'

const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' })
const codeState = () => ({
  commit: git('rev-parse', 'HEAD').trim(),
  uncommitted: git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(l => l !== ''),
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
const atStart = codeState()
{
  const store = new Store(join(DATA, 'eos.db'))
  new Conventions(store).seed(Date.now())
  store.close()
}
// 只读核对用的一个连接（平台在另一个进程里写，这里读得到已提交的内容）。
let conn: DatabaseSync | undefined
const db = () => (conn ??= new DatabaseSync(join(DATA, 'eos.db')))
const conventionsDump = () => JSON.stringify(db().prepare('SELECT * FROM conventions ORDER BY kind, name, version').all())
const before = conventionsDump()

// 假模型：读 standard → 提议 review-only → 回答；接着说时直接回答。每一步之间停一下，让页面看得到按步推送。
const fakeYaml = () => {
  const s = new Store(join(DATA, 'eos.db'))
  const y = s.convention('workflow', 'standard')!.content
  s.close()
  return y.replace(/^name: .*$/m, 'name: review-only')
}
const script = async (req: Request): Promise<Reply> => {
  const done = req.messages.flatMap(m => m.content.filter(b => b.type === 'tool_result')).length
  const asks = req.messages.filter(m => m.role === 'user' && m.content.some(b => b.type === 'text')).length
  await sleep(1500)
  if (asks > 1) return { kind: 'text', text: '好的，还有别的要改的吗？' }
  if (done === 0) return { kind: 'tool', name: 'mcp__eos__get_convention', input: { kind: 'workflow', name: 'standard' } }
  if (done === 1) return { kind: 'tool', name: `mcp__eos__${PROPOSE_TOOL}`, input: { kind: 'workflow', name: 'review-only', content: fakeYaml(), rationale: '按要求设计' } }
  return { kind: 'text', text: '已经提议了工作流 review-only，等你确认后保存。' }
}
const model = fake ? await startFakeModel(() => {}, script) : undefined

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'EOS_MODEL_BASE_URL' && k !== 'DEEPSEEK_BASE_URL' && k !== 'EOS_MASTER_KEY')),
  NODE_USE_ENV_PROXY: '1',
  DEEPSEEK_API_KEY: KEY,
  ...(model === undefined ? {} : { EOS_MODEL_BASE_URL: model.baseUrl }),
}
const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverOut = ''
web.stdout.on('data', d => (serverOut += String(d)))
web.stderr.on('data', d => (serverOut += String(d)))

const checks: [string, boolean, unknown?][] = []
const check = (name: string, ok: boolean, detail?: unknown) => {
  checks.push([name, ok, detail])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}
const errors: string[] = []
const widths390: Record<string, number> = {}
let chatId: string | undefined
const browser = await chromium.launch()
try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${base}/api/chats`)
      break
    } catch {
      await sleep(500)
    }
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  page.on('pageerror', (e: Error) => errors.push(e.message))
  await page.goto(`${base}/#/`)
  await page.getByRole('link', { name: '对话', exact: true }).click()
  await page.waitForURL(/#\/chat$/)
  check('导航里有「对话」，点进去是对话页', (await page.locator('h1').textContent()) === '对话')
  await page.locator('.chat-composer textarea').fill(ASK)
  // 回复完成之前：「正在回复」的那一格里出现过读了什么。用 MutationObserver 记下来，回复很快时也不会错过。
  await page.evaluate(() => {
    const w = window as unknown as { liveReads: string[] }
    w.liveReads = []
    new MutationObserver(() => {
      for (const li of document.querySelectorAll('.chat-msg.live .chat-reads li')) if (!w.liveReads.includes(li.textContent ?? '')) w.liveReads.push(li.textContent ?? '')
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })
  await page.getByRole('button', { name: '发送' }).click()
  await page.waitForURL(/#\/chat\/c[0-9a-z]+$/, { timeout: 900_000 })
  const liveReads = (await page.evaluate(() => (window as unknown as { liveReads: string[] }).liveReads)) as string[]
  check('回复完成之前，页面上已经显示 agent 读了什么（按步推送）', liveReads.length > 0, liveReads)
  chatId = /#\/chat\/(c[0-9a-z]+)$/.exec(page.url())?.[1]
  await page.locator('.chat-msg.assistant').first().waitFor()
  const reads: string[] = await page.locator('.chat-msg.assistant .chat-reads li').allTextContents()
  check('回复完成后跳到这个对话，回复上列出读了哪些数据', chatId !== undefined && reads.some(r => r.startsWith('读了')) && reads.some(r => r.startsWith('提议')), reads)

  // 要保存的：通过检查、没作废、能保存的 review-only 提议（模型可能先提别的）；没有就取第一条能保存的。
  const proposals = db()
    .prepare('SELECT id, kind, name FROM chat_proposals WHERE chat_id = ? AND voided IS NULL ORDER BY id')
    .all(chatId ?? '') as { id: number; kind: string; name: string }[]
  const card = async (id: number) => page.locator(`section[aria-label="提议 #${id}"]`)
  let target: number | undefined
  for (const p of [...proposals].sort((a, b) => Number(b.name === 'review-only') - Number(a.name === 'review-only')))
    if ((await (await card(p.id)).getByRole('button', { name: '保存' }).count()) === 1) {
      target = p.id
      break
    }
  check('至少一条提议可以保存', target !== undefined, proposals)
  check('保存之前约定表一行都没变', conventionsDump() === before)
  if (target !== undefined) {
    const c = await card(target)
    const fresh = await c.locator('.chat-proposal-head').textContent()
    const warn = await c.locator('.chat-permissions').count()
    const diffLines = await c.locator('pre.diff > div').count()
    check('提议显示差异（新建显示全文）和醒目的权限警告', diffLines > 5 && warn === 1 && (fresh?.includes('新建') ?? false), { head: fresh, diffLines })
    const button = c.getByRole('button', { name: '保存' })
    check('没勾确认之前「保存」不可用', await button.isDisabled())
    await c.locator('.chat-allow input[type=checkbox]').check()
    await c.locator('.chat-note').fill('E2E 网页确认')
    await page.screenshot({ path: join(SHOTS, 'chat-1440-proposal.png'), fullPage: true })
    // 手机宽度下待确认的提议（权限警告、差异、确认框）。
    const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } })
    narrow.on('pageerror', (e: Error) => errors.push(e.message))
    await narrow.goto(`${base}/#/chat/${chatId}`)
    await narrow.locator('.chat-permissions').first().waitFor()
    widths390.proposal = await narrow.evaluate(() => document.documentElement.scrollWidth)
    await narrow.screenshot({ path: join(SHOTS, 'chat-390-proposal.png'), fullPage: true })
    await narrow.close()
    await button.click()
    await c.locator('.pill', { hasText: '已保存' }).waitFor({ timeout: 30_000 })
    const name = proposals.find(p => p.id === target)!.name
    const row = db().prepare("SELECT version, actor, note, content FROM conventions WHERE kind = 'workflow' AND name = ? ORDER BY version DESC").get(name) as
      { version: number; actor: string; note: string; content: string } | undefined
    const proposed = db().prepare('SELECT content FROM chat_proposals WHERE id = ?').get(target) as { content: string }
    check(
      '勾上确认之后保存成第 1 版：操作人 web，备注写明对话、提议和确认了的权限，内容就是提议的内容',
      row?.version === 1 &&
        row.actor === 'web' &&
        row.note.startsWith(`来自对话 ${chatId} 的提议 #${target}（确认了权限改动：`) &&
        row.note.endsWith('）：E2E 网页确认') &&
        row.content === proposed.content,
      { version: row?.version, actor: row?.actor, note: row?.note },
    )
    check('保存后显示「已保存」、不再有保存按钮', (await c.getByRole('button', { name: '保存' }).count()) === 0)
  }

  // 接着说一句。
  await page.locator('.chat-composer textarea').fill('好的，先这样。')
  await page.getByRole('button', { name: '发送' }).click()
  // 等这一轮做完：「正在回复」那一格消失，记录重新读出来。
  await page.waitForFunction(() => document.querySelectorAll('.chat-log .chat-msg.assistant:not(.live)').length === 2 && document.querySelector('.chat-msg.live') === null, undefined, {
    timeout: 900_000,
  })
  check('在对话里接着说，记录变成 4 条', (await page.locator('.chat-log .chat-msg:not(.live)').count()) === 4)
  await page.screenshot({ path: join(SHOTS, 'chat-1440.png'), fullPage: true })

  await page.goto(`${base}/#/chat`)
  await page.locator('.chat-list li').first().waitFor()
  check('历史对话列表里有这个对话', (await page.locator(`.chat-list a[href="#/chat/${chatId}"]`).count()) === 1)

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } })
  phone.on('pageerror', (e: Error) => errors.push(e.message))
  for (const [name, hash] of [
    ['list', '#/chat'],
    ['chat', `#/chat/${chatId}`],
  ] as const) {
    await phone.goto(`${base}/${hash}`)
    await phone
      .locator(name === 'list' ? '.chat-list li' : '.chat-proposal')
      .first()
      .waitFor()
    widths390[name] = await phone.evaluate(() => document.documentElement.scrollWidth)
    await phone.screenshot({ path: join(SHOTS, `chat-390-${name}.png`), fullPage: true })
  }
  check('390 宽不横向滚动（待确认的提议、对话、列表）', Object.keys(widths390).length === 3 && Object.values(widths390).every(w => w <= 390), widths390)
  const pageText = (await page.content()) + (await phone.content())
  const messages = db()
    .prepare('SELECT text, call FROM chat_messages WHERE chat_id = ?')
    .all(chatId ?? '')
  check('平台持有的模型 key 不在页面、对话记录和服务输出里', !pageText.includes(KEY) && !JSON.stringify(messages).includes(KEY) && !serverOut.includes(KEY))
  check('页面没有脚本错误', errors.length === 0, errors)
} catch (e) {
  check('脚本跑完', false, String((e as Error).stack ?? e))
} finally {
  await browser.close()
  web.kill()
  await model?.close()
}

const atEnd = codeState()
const report = {
  mode: fake ? 'fake-model' : 'real-model',
  ...atStart,
  ...(atEnd.commit !== atStart.commit ? { commitAtEnd: atEnd.commit } : {}),
  chat: chatId,
  checks: checks.map(([name, ok, detail]) => ({ name, ok, ...(detail === undefined ? {} : { detail }) })),
  log: chatId === undefined ? [] : db().prepare('SELECT seq, role, text, call FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(chatId),
  proposals: chatId === undefined ? [] : db().prepare('SELECT id, kind, name, voided, saved_version, saved_actor, content FROM chat_proposals WHERE chat_id = ? ORDER BY id').all(chatId),
}
writeFileSync(join(SHOTS, 'report.json'), JSON.stringify(report, null, 2))
console.log(`\n${checks.filter(([, ok]) => ok).length}/${checks.length} 项通过。报告：${join(SHOTS, 'report.json')}`)
process.exit(checks.every(([, ok]) => ok) && checks.length > 0 ? 0 : 1)
