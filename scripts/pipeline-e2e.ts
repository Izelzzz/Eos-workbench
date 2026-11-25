// 第 1 块端到端验证：团队约定 + 交付物检查 + 测试失败退回开发，全程浏览器操作，真实模型。
// 1. 启动 eos web；在「团队约定」页打开内置的 standard 工作流，改两处后保存为第 2 版（见下面「人为设置」）；
// 2. 新建任务，选 standard 第 2 版，写需求；agent 提问时在页面上回答；
// 3. 等任务结束，截图 trace 里没通过的检查；从存储核对结果，写 report.json。
//
// 人为设置（如实写进报告）：
// - 开发节点的任务说明改成「先不要写 docs/changes.md，平台检查会提醒你补」，让交付物检查必然先失败一次；
// - 测试节点的命令换成平台持有的验收测试（在 worktree 外面，开发看不到）。需求说「写法参考 Go 的 time.ParseDuration」，
//   验收测试里有小数（1.5h），开发如果没想到就会失败、把失败输出交回开发。
// - 验收测试里还有一条需求里没写的用例（单位大写 1H30M 也要支持）：第 1 次运行开发把小数做对了，测试一次就过、没有触发
//   "测试失败 → 退回开发"，所以加了这一条来确定触发。它证明的是退回机制，不是模型会漏掉边界情况。
// 用法：NODE_PATH=<playwright 所在目录> node --import tsx scripts/pipeline-e2e.ts [端口]
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'pipeline-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const ACCEPTANCE = join(OUT, 'acceptance', 'duration.test.mjs')
const port = Number(process.argv[2] ?? 4321)
const base = `http://127.0.0.1:${port}`
const REQUEST =
  '在 src/duration.js 实现并导出 parseDuration(text)：把 "1h30m" 这样的时长字符串转换成秒数（数字）。写法参考 Go 的 time.ParseDuration，只需要支持 h、m、s 三个单位，单位可以组合；非法输入抛 RangeError。用 node:test 写测试，npm test 必须通过。'

const note = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  appendFileSync(join(OUT, 'steps.log'), `${line}\n`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
mkdirSync(join(OUT, 'acceptance'))
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init'],
])
  execFileSync('git', a, { cwd: REPO })
writeFileSync(
  ACCEPTANCE,
  `// 平台持有的验收测试：在任务的 worktree 里运行（cwd），开发看不到这个文件。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
const { parseDuration } = await import(pathToFileURL(join(process.cwd(), 'src', 'duration.js')).href)
test('组合单位', () => assert.equal(parseDuration('1h30m'), 5400))
test('单个单位', () => { assert.equal(parseDuration('45s'), 45); assert.equal(parseDuration('2h'), 7200) })
test('三个单位', () => assert.equal(parseDuration('1h2m3s'), 3723))
test('小数（Go 的写法支持）', () => assert.equal(parseDuration('1.5h'), 5400))
test('单位大小写都可以（需求里没写，验收测试才有）', () => assert.equal(parseDuration('1H30M'), 5400))
test('非法输入抛 RangeError', () => { for (const s of ['', '10x', 'h', '1h30']) assert.throws(() => parseDuration(s), RangeError, JSON.stringify(s)) })
`,
)

const startServer = async (): Promise<ChildProcess> => {
  const out = openSync(join(OUT, 'server.log'), 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' },
  })
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/tasks`)).ok) return child
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  throw new Error('eos web 没有启动')
}

const server = await startServer()
note(`eos web 已启动（pid ${server.pid}）`)
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
const errors: string[] = []
page.on('pageerror', (e: Error) => errors.push(e.message))
let shot = 0
const snap = async (name: string, fullPage = false) => page.screenshot({ path: join(OUT, `${String(++shot).padStart(2, '0')}-${name}.png`), fullPage })

// 1. 团队约定页：改 standard 工作流，保存为第 2 版。
await page.goto(`${base}/#/`)
await page.getByRole('link', { name: '团队约定' }).click()
await page.getByRole('link', { name: /^standard/ }).click()
const editor = page.getByLabel('工作流内容')
await editor.waitFor()
const original = await editor.inputValue()
const BUILD_TASK = 'task: 按 docs/spec.md 实现需求，并把改动说明写到 docs/changes.md。'
const TEST_CHECK = '      - { run: [npm, test], timeoutSec: 600 }\n\n  - id: review'
if (!original.includes(BUILD_TASK) || !original.includes(TEST_CHECK)) throw new Error('内置 standard 模板和脚本对不上，需要更新脚本')
const edited = original
  .replace(BUILD_TASK, 'task: 按 docs/spec.md 实现需求。先不要写 docs/changes.md，平台检查会提醒你补。')
  .replace('      - { run: [npm, test], timeoutSec: 600 }\n\n  - id: review', `      - { run: [node, --test, ${JSON.stringify(ACCEPTANCE)}], timeoutSec: 300 }\n\n  - id: review`)
// 先写一个错误，看页面给出的中文错误和位置。
await editor.fill(edited.replace('kind: dialog', 'kind: dailog'))
await page.getByRole('alert', { name: '错误' }).waitFor({ timeout: 10_000 })
const yamlError = await page.getByRole('alert', { name: '错误' }).innerText()
note(`故意写错 kind，页面提示：${yamlError}`)
await snap('convention-error')
await editor.fill(edited)
await page.getByText('格式正确，可以保存').waitFor({ timeout: 10_000 })
await page.getByLabel('修改说明').fill('测试换成平台持有的验收测试；开发先不写改动说明（E2E 人为设置）')
await snap('convention-edit')
await page.getByRole('button', { name: '保存为新版本' }).click()
await page.getByText('已保存为第 2 版').waitFor({ timeout: 10_000 })
await snap('convention-saved', true)
note('standard 工作流保存为第 2 版')

// 2. 新建任务。
await page.getByRole('link', { name: '任务' }).click()
await page.getByRole('link', { name: '新建任务' }).click()
await page.getByRole('form', { name: '新建任务' }).waitFor()
await page.getByPlaceholder(/path\/to\/your\/repo/).fill(REPO)
await page.locator('.new-task select').selectOption('standard')
await page.locator('.new-task textarea').fill(REQUEST)
await snap('new-task')
await page.getByRole('button', { name: '创建并开始' }).click()
await page.waitForURL(/#\/tasks\/t\w+/)
const id = /#\/tasks\/(t\w+)/.exec(page.url())![1]!
note(`页面上创建了任务 ${id}`)

const detail = async () => (await (await fetch(`${base}/api/tasks/${id}`)).json()) as { status: string; position: string }
const answers: string[] = []
let lastPosition = ''
const until = Date.now() + 40 * 60_000
while (Date.now() < until) {
  const form = page.getByRole('form', { name: '回答提问' })
  if ((await form.count()) > 0) {
    const q = await form.locator('.question-text').innerText()
    if (answers.length === 0) await snap('question')
    const option = form.locator('.options button').first()
    if ((await option.count()) > 0) {
      const choice = await option.innerText()
      await option.click()
      answers.push(choice)
      note(`页面回答（选项）：${q.slice(0, 120)} → ${choice}`)
    } else {
      const text = '按你的判断选最合理的做法，在交付说明里写清楚。'
      await form.locator('textarea').fill(text)
      await form.getByRole('button', { name: '回答' }).click()
      answers.push(text)
      note(`页面回答（文字）：${q.slice(0, 120)} → ${text}`)
    }
    await page.waitForFunction((text: string) => document.querySelector('.question-text')?.textContent !== text, q, { timeout: 15_000 }).catch(() => {})
    continue
  }
  let d: Awaited<ReturnType<typeof detail>> | undefined
  try {
    d = await detail()
  } catch {
    d = undefined
  }
  if (d !== undefined && d.position !== lastPosition) {
    note(`位置：${d.position}（${d.status}）`)
    lastPosition = d.position
  }
  if (d?.status === 'done' || d?.status === 'failed' || d?.status === 'aborted') break
  await sleep(2000)
}

// 3. 截图：没通过的检查默认展开，点开它看原因。
await page.reload()
await page.locator('.trace-row').first().waitFor()
const failed = page.locator('.trace-row.kind-check', { hasText: '没有通过' })
const nFailed = await failed.count()
for (let i = 0; i < nFailed; i++) {
  const row = failed.nth(i)
  await row.scrollIntoViewIfNeeded()
  // 点开这次检查下面第一项没通过的检查，详情里显示原因。
  const item = page
    .locator('.trace-row.kind-check')
    .filter({ has: page.locator('.dot.error') })
    .nth(i * 2 + 1)
  await ((await item.count()) > 0 ? item : row).click()
  await snap(`check-failed-${i + 1}`)
}
await page.getByRole('button', { name: '收起到调用' }).click()
await snap('done', true)
await browser.close()
process.kill(-server.pid!, 'SIGTERM')

// 4. 从存储核对。
const store = new Store(join(DATA, 'eos.db'))
const task = store.get(id)!
const meta = store.meta(id)
type Item = { kind: 'call' | 'check'; node: string; purpose?: string; session?: string; passed?: boolean; prompt?: string }
const items: Item[] = task.log.flatMap<Item>(e =>
  e.type === 'call'
    ? [{ kind: 'call' as const, node: e.node, purpose: e.purpose, prompt: e.prompt }]
    : e.type === 'check'
      ? [{ kind: 'check' as const, node: e.node, passed: e.results.every(r => r.passed) }]
      : [],
)
/** 在 items 里依次找到这些条件（中间可以隔着别的）。 */
const inOrder = (...steps: ((x: Item) => boolean)[]): boolean => {
  let k = 0
  for (const x of items) if (k < steps.length && steps[k]!(x)) k++
  return k === steps.length
}
const firstPromptOfSession = new Map<string, string>()
for (const e of task.log)
  if (e.type === 'call') {
    const session = e.purpose === 'produce' || e.purpose === 'fix' || e.purpose === 'critique' ? e.node : e.purpose === 'reconfirm' ? 'spec' : 'build'
    if (!firstPromptOfSession.has(session)) firstPromptOfSession.set(session, e.prompt)
  }
const testFailures = items.filter(x => x.kind === 'check' && x.node === 'test' && x.passed === false).length
const npmTest = (() => {
  try {
    execFileSync('npm', ['test'], { cwd: meta.worktree, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
const checks = {
  '工作流在页面上改过并保存为第 2 版，历史里有第 1 版（内置）':
    store
      .conventionHistory('workflow', 'standard')
      .map(r => r.version)
      .join(',') === '2,1',
  '页面对写错的 YAML 给出中文错误和位置': /nodes\[\d+\]\.kind/.test(yamlError) && /agent 或 dialog/.test(yamlError),
  '任务记录了用到的约定版本（standard 第 2 版、研发约定第 1 版）':
    JSON.stringify({ workflow: meta.conventions?.workflow, docs: meta.conventions?.docs }) === JSON.stringify({ workflow: { name: 'standard', version: 2 }, docs: [{ name: '研发约定', version: 1 }] }),
  约定文档注入到每个会话的第一条提示词: firstPromptOfSession.size > 0 && [...firstPromptOfSession.values()].every(p => p.includes('团队约定：研发约定（第 1 版）')),
  '开发的交付物检查没通过 → 同一个 agent 补齐 → 检查通过': inOrder(
    x => x.kind === 'check' && x.node === 'build' && x.passed === false,
    x => x.purpose === 'fix' && x.node === 'build',
    x => x.kind === 'check' && x.node === 'build' && x.passed === true,
  ),
  '测试失败 → 交回开发修改 → 重跑通过': inOrder(
    x => x.kind === 'check' && x.node === 'test' && x.passed === false,
    x => x.purpose === 'respond' && x.node === 'test',
    x => x.kind === 'check' && x.node === 'test' && x.passed === true,
  ),
  '评审这一轮先跑测试，通过后才请评审方': inOrder(
    x => x.kind === 'check' && x.node === 'review' && x.passed === true,
    x => x.purpose === 'critique',
  ),
  任务完成: task.status === 'done',
  'worktree 里 npm test 通过': npmTest,
  页面没有脚本错误: errors.length === 0,
}
const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const code = { commit: git('rev-parse', '--short', 'HEAD'), uncommitted: git('status', '--porcelain', '--', 'src', 'web/src', 'scripts', 'package.json').split('\n').filter(Boolean) }
const report = {
  task: id,
  code,
  status: task.status,
  failure: task.failure,
  answers,
  testFailures,
  induced: [
    '开发节点的任务说明要求先不写 docs/changes.md（让交付物检查先失败一次）',
    '测试节点改用 worktree 外的验收测试（含 1.5h 小数用例）',
    '验收测试里加了需求没写的大写单位用例（1H30M），确定触发测试失败退回开发',
  ],
  timeline: items.map(x => (x.kind === 'call' ? `${x.purpose}@${x.node}` : `check@${x.node}:${x.passed ? '通过' : '没通过'}`)),
  checks,
  errors,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
