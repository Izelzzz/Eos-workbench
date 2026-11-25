// 第 2 块端到端验证：团队级 Agent 模板，全程浏览器操作，真实模型。
// 1. 启动 eos web；在「团队约定」页打开内置的 developer 模板，加一个 MCP 服务后保存为第 2 版；
// 2. 新建任务，用内置 standard 工作流（角色都引用模板）；agent 提问时在页面上回答；
// 3. 等任务结束，截图；从存储、trace 和 dsh 会话日志核对，写 report.json。
//
// 人为设置（如实写进报告）：
// - 需求里要求开发先调用 MCP 工具 probe_code，把它返回的口令写进 docs/changes.md：让 MCP 一定被用到；
// - 需求里要求写 docs/changes.md 前先用 write-changes 技能：让技能一定被用到；
// - 需求里要求顺手把仓库根目录 README.md 第一行改掉：README.md 在开发模板的写入范围之外，用来触发"越界改动被撤销"。
// 它们证明的是模板的机制（MCP、技能、写入范围、工具组、版本记录），不是模型自己会不会这样做。
// 用法：node --import tsx scripts/templates-e2e.ts [端口]
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DshExecutor } from '../src/executor/dsh.ts'
import { sessionOf } from '../src/engine/machine.ts'
import { keyOf } from '../src/runner/runner.ts'
import { Store } from '../src/store/store.ts'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'templates-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const MCP_SERVER = join(ROOT, 'scripts', 'template-probe-mcp.mjs')
const MCP_CODE = 'TEAM-7719'
const README = '# demo\n\n示例仓库。\n'
const port = Number(process.argv[2] ?? 4322)
const base = `http://127.0.0.1:${port}`
const REQUEST = [
  '在 src/clamp.js 实现并导出 clamp(value, min, max)：把数字限制在 [min, max] 之间；min 大于 max 时抛 RangeError。用 node:test 写测试，npm test 必须通过。',
  '另外三件事（团队这次试用新模板，请照做）：',
  `1. 开发开始前，先调用 MCP 工具 probe_code（服务 team-info），把它返回的团队编号原样写进 docs/changes.md 的「验证」一节。`,
  '2. 写 docs/changes.md 之前，先用 write-changes 技能看团队约定的格式。',
  '3. 顺手把仓库根目录 README.md 的第一行改成「# clamp」。',
].join('\n')

const note = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  appendFileSync(join(OUT, 'steps.log'), `${line}\n`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
writeFileSync(join(REPO, 'README.md'), README)
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init'],
])
  execFileSync('git', a, { cwd: REPO })

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

// 1. 团队约定页：给 developer 模板加一个 MCP 服务，保存为第 2 版。
await page.goto(`${base}/#/`)
await page.getByRole('link', { name: '团队约定' }).click()
await page.getByRole('link', { name: /^developer/ }).click()
const editor = page.getByLabel('Agent 模板内容')
await editor.waitFor()
const original = await editor.inputValue()
if (!original.includes('skills: [write-changes]')) throw new Error('内置 developer 模板和脚本对不上，需要更新脚本')
const mcpBlock = `mcp:\n  - { name: team-info, command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(MCP_SERVER)}, ${MCP_CODE}] }\n`
await editor.fill(original.replace('skills: [write-changes]\n', `skills: [write-changes]\n${mcpBlock}`))
await page.getByText('格式正确，可以保存').waitFor({ timeout: 10_000 })
await page.getByLabel('修改说明').fill('加上团队信息 MCP 服务（E2E）')
await snap('template-edit-with-warning')
await page.getByRole('button', { name: '保存为新版本' }).click()
await page.getByText('已保存为第 2 版').waitFor({ timeout: 10_000 })
await snap('template-saved', true)
note('developer 模板保存为第 2 版（加了 MCP 服务 team-info）')

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

// 3. 截图：任务页（用到的模板版本）、越界撤销的那次调用、技能和 MCP 的工具调用。
await page.reload()
await page.locator('.trace-row').first().waitFor()
await snap('task-page')
await page.getByRole('button', { name: '全部展开' }).click()
const store = new Store(join(DATA, 'eos.db'))
const task = store.get(id)!
const revertEntry = task.log.find(e => e.type === 'call' && (e.reverted?.length ?? 0) > 0)
if (revertEntry?.type === 'call') {
  const row = page
    .locator(`.trace-row`)
    .filter({ hasText: /developer · / })
    .nth(0)
  await row.scrollIntoViewIfNeeded()
  await row.click()
  await snap('call-with-reverted-paths')
}
for (const name of [/skill/, /mcp__team-info__probe_code|mcp__/]) {
  const tool = page.locator('.trace-row.kind-tool').filter({ hasText: name }).first()
  if ((await tool.count()) > 0) {
    await tool.scrollIntoViewIfNeeded()
    await tool.click()
    await snap(`tool-${String(name).replace(/\W+/g, '-').replace(/^-|-$/g, '')}`)
  }
}
await page.getByRole('button', { name: '收起到调用' }).click()
await snap('done', true)
await browser.close()
process.kill(-server.pid!, 'SIGTERM')
await sleep(2000)

// 4. 从存储、trace 和 dsh 会话日志核对。
const meta = store.meta(id)
const trace = store.trace(id)
const calls = task.log.flatMap(e => (e.type === 'call' ? [e] : []))
const toolCalls = (callIds: Set<string>) => trace.filter(r => callIds.has(r.call) && r.event.kind === 'tool_start').map(r => r.event as { kind: 'tool_start'; name: string; args: string; id: string })
const devCallIds = new Set(calls.filter(c => c.role === 'developer').map(c => c.call as string))
const devTools = toolCalls(devCallIds)
const toolOutput = (toolId: string) => trace.find(r => r.event.kind === 'tool_end' && r.event.id === toolId)?.event as { output: string } | undefined
const mcpCall = devTools.find(t => t.name.startsWith('mcp__') && t.name.endsWith('__probe_code'))
const skillCall = devTools.find(t => t.name === 'skill' && t.args.includes('write-changes'))
const reverted = calls.filter(c => (c.reverted?.length ?? 0) > 0)
const revertedSession = reverted[0] === undefined ? undefined : reverted[0].node
// 撤销发生在哪个会话，就核对这个会话里紧接着的下一次调用：它的提示词必须以撤销说明开头，并列出 README.md。
const sessionOfCall = (c: (typeof calls)[number]) => sessionOf(task.workflow, c)
const nextInSameSession = reverted[0] === undefined ? undefined : calls.find(c => c.at > reverted[0]!.at && sessionOfCall(c) === sessionOfCall(reverted[0]!))
const noticeDelivered = nextInSameSession !== undefined && /^# 有改动被撤销（超出你的可写范围）\n/.test(nextInSameSession.prompt) && nextInSameSession.prompt.includes('- README.md')
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const readmeInBranch = git(meta.worktree, 'show', `HEAD:README.md`)
const branchFiles = git(meta.worktree, 'diff', '--name-only', meta.baseSha, 'HEAD').split('\n').filter(Boolean)
const changes = (() => {
  try {
    return git(meta.worktree, 'show', 'HEAD:docs/changes.md')
  } catch {
    return ''
  }
})()
const reader = new DshExecutor({ dshHome: join(DATA, 'dsh'), dshBin: join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), modelKey: () => '' })
const offered = (session: string) => reader.toolsOffered(keyOf(id, session))
const skillsSeen = (session: string) => reader.skillsOffered(keyOf(id, session))
const npmTest = (() => {
  try {
    execFileSync('npm', ['test'], { cwd: meta.worktree, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
// 各工具组在这套 dsh 里实际出现的工具（docs/e2e/b2/template-probe.json 的基线）。
const WEB = ['web_fetch', 'web_search']
const SUBAGENT = ['subagent', 'subagent_fork', 'list_agents', 'send_message', 'wait_agent', 'workflow']
const SCHEDULE = ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']
const used = meta.conventions
const checks = {
  '模板在页面上改过并保存为第 2 版，历史里有第 1 版（内置）':
    store
      .conventionHistory('template', 'developer')
      .map(r => r.version)
      .join(',') === '2,1',
  '任务记录了用到的模板和技能版本（developer 第 2 版，spec-writer、reviewer 第 1 版，write-changes 第 1 版）':
    JSON.stringify(used?.templates) ===
      JSON.stringify([
        { name: 'developer', version: 2 },
        { name: 'reviewer', version: 1 },
        { name: 'spec-writer', version: 1 },
      ]) && JSON.stringify(used?.skills) === JSON.stringify([{ name: 'write-changes', version: 1 }]),
  'MCP：开发调用了模板里的 MCP 工具，返回值来自这个服务': mcpCall !== undefined && (toolOutput(mcpCall.id)?.output ?? '').includes(MCP_CODE),
  'MCP：返回的编号写进了 docs/changes.md': changes.includes(MCP_CODE),
  '技能：开发用了模板给的 write-changes 技能': skillCall !== undefined,
  '技能隔离：开发只看到 write-changes，评审看不到任何技能': JSON.stringify(skillsSeen('build')) === JSON.stringify(['write-changes']) && skillsSeen('review').length === 0,
  '工具组：评审的 dsh 工具表里没有 web、subagent、schedule 组的任何工具': offered('review').length > 0 && !offered('review').some(t => [...WEB, ...SUBAGENT, ...SCHEDULE].includes(t)),
  '工具组：开发的 dsh 工具表里没有 subagent、schedule 组的任何工具，但有 bash 和读写文件':
    offered('build').length > 0 && !offered('build').some(t => [...SUBAGENT, ...SCHEDULE].includes(t)) && ['bash', 'write', 'read', 'edit'].every(t => offered('build').includes(t)),
  'MCP 只给开发：评审的工具表里没有 MCP 工具': offered('review').length > 0 && !offered('review').some(t => t.startsWith('mcp__')),
  '写入范围：越界改动（README.md）被撤销，记在调用上': reverted.some(c => c.reverted!.includes('README.md')),
  '写入范围：任务分支里 README.md 没被改，提交里没有它': readmeInBranch === README.trimEnd() && !branchFiles.includes('README.md'),
  '写入范围：撤销发生的那个会话的下一次调用，提示词以撤销说明开头并列出 README.md': noticeDelivered,
  任务完成: task.status === 'done',
  'worktree 里 npm test 通过': npmTest,
  页面没有脚本错误: errors.length === 0,
}
const here = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const report = {
  task: id,
  code: { commit: here('rev-parse', '--short', 'HEAD'), uncommitted: here('status', '--porcelain', '--', 'src', 'web/src', 'scripts', 'package.json').split('\n').filter(Boolean) },
  status: task.status,
  failure: task.failure,
  answers,
  induced: ['需求要求开发先调用 MCP 工具 probe_code 并把编号写进 docs/changes.md', '需求要求写改动说明前先用 write-changes 技能', '需求要求改 README.md 第一行（在开发模板的写入范围之外）'],
  conventions: used,
  reverted: reverted.map(c => ({ call: c.call, node: c.node, role: c.role, paths: c.reverted })),
  revertedSession,
  toolsOffered: { build: offered('build'), review: offered('review'), spec: offered('spec') },
  skillsOffered: { build: skillsSeen('build'), review: skillsSeen('review'), spec: skillsSeen('spec') },
  developerTools: devTools.map(t => t.name),
  branchFiles,
  timeline: task.log.flatMap(e =>
    e.type === 'call'
      ? [`${e.purpose}@${e.node}${e.reverted?.length ? `（撤销 ${e.reverted.join('、')}）` : ''}`]
      : e.type === 'check'
        ? [`check@${e.node}:${e.results.every(r => r.passed) ? '通过' : '没通过'}`]
        : [],
  ),
  checks,
  errors,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
