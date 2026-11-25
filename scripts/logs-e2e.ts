// 试用反馈第 3 条的端到端验证：日志文件和看得懂的失败原因。真实模型、eos web，人为制造两种失败：
// A. 调用进行中结掉这个任务的 dsh 进程（按进程的工作目录认，不碰别的进程）；之后在页面上点「重试」，任务接着跑完。
// B. 开发调用进行中删掉任务的 worktree。
// 每种失败都核对：失败原因三段（哪一步、原因、怎么修）；任务详情和命令行给出日志路径；日志文件带时间戳、有完整错误；
// /api/tasks/:id/log 能看到日志；Web 服务进程的日志写进 logs/eos.log。任务页截图（桌面 1440 宽、手机 390 宽）。
// 用法：node --import tsx scripts/logs-e2e.ts [端口]
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright') as { chromium: { launch: () => Promise<any> } }

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'logs-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4341)
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }
const REQUEST = '在 src/add.js 实现并导出 add(a, b)，返回两数之和；用 node:test 写测试放在 test/ 目录，npm test 必须通过。不需要问我任何问题，有歧义按最简单的做法。'

const note = (s: string) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  console.log(line)
  appendFileSync(join(OUT, 'steps.log'), `${line}\n`)
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })

type Detail = { status: string; failure?: string; logPath: string; position: string; worktree: string }
const detail = async (id: string) => (await (await fetch(`${base}/api/tasks/${id}`)).json()) as Detail
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
const until = async (what: string, ok: () => Promise<boolean>, ms = 15 * 60_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok()) return
    await sleep(1000)
  }
  throw new Error(`等不到：${what}`)
}

/** 这个数据目录的 dsh 进程：工作目录是 <数据目录>/dsh/eos-process-cwd（见 executor/dsh.ts 的 processCwd）。 */
const dshPids = (): number[] => readdirSync('/proc').filter(p => /^\d+$/.test(p)).flatMap(p => {
  try {
    return readlinkSync(`/proc/${p}/cwd`) === join(DATA, 'dsh', 'eos-process-cwd') ? [Number(p)] : []
  } catch {
    return []
  }
})

/** 当前调用的 trace 里已经有了模型的步骤：调用确实在进行中。 */
const callRunning = async (id: string, node: string) => {
  const d = await detail(id)
  return d.status === 'running' && d.position.includes(node) && dshPids().length > 0
}

const startServer = async (): Promise<ChildProcess> => {
  const out = openSync(join(OUT, 'server.log'), 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], { cwd: ROOT, detached: true, stdio: ['ignore', out, out], env })
  await until('eos web 启动', async () => { try { return (await fetch(`${base}/api/tasks`)).ok } catch { return false } }, 30_000)
  return child
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
execFileSync('npm', ['run', 'build:web'], { cwd: ROOT, stdio: 'ignore' })
const server = await startServer()
note(`eos web 已启动（提交 ${commit}，Node ${process.version}）`)
const browser = await chromium.launch()
const shots: string[] = []
const snap = async (id: string, name: string) => {
  for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, '390']] as const) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
    await page.goto(`${base}/#/tasks/${id}`)
    await page.locator('.failure').waitFor({ timeout: 20_000 })
    const file = `${name}-${tag}.png`
    await page.locator('.summary').screenshot({ path: join(OUT, file) })
    shots.push(file)
    await page.close()
  }
}

const checkFailure = async (id: string, label: string) => {
  const d = await detail(id)
  const logText = await (await fetch(`${base}/api/tasks/${id}/log`)).text()
  const file = existsSync(d.logPath) ? readFileSync(d.logPath, 'utf8') : ''
  const cli = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'status', id, '--data', DATA], { cwd: ROOT, env, encoding: 'utf8' })
  note(`${label} 失败原因：\n${d.failure}`)
  return {
    failure: d.failure, logPath: d.logPath,
    checks: {
      [`${label}：失败原因分三段（哪一步、原因、怎么修）`]: /^哪一步：.+\n原因：.+\n怎么修：.+/.test(d.failure ?? ''),
      [`${label}：认出了这个错误，给出具体修法`]: !(d.failure ?? '').includes('没有认出这个错误'),
      [`${label}：任务详情给出日志路径，在数据目录的 logs/ 下`]: d.logPath === join(DATA, 'logs', `${id}.log`),
      [`${label}：日志文件每行带时间、有失败的那一行和完整错误`]: /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(file) && /✗ /.test(file) && /的完整错误：/.test(file),
      [`${label}：网页接口返回的日志和文件一致`]: logText === file,
      [`${label}：命令行 status 显示失败原因和日志路径`]: cli.stdout.includes('失败原因\n哪一步：') && cli.stdout.includes(`日志：${d.logPath}`),
    },
  }
}

const results: Record<string, unknown> = {}
const checks: Record<string, boolean> = {}
try {
  // A. 结掉 dsh 进程。
  const a = (await (await post('/api/tasks', { repo: REPO, workflow: 'standard', request: REQUEST })).json()) as { id: string }
  note(`任务 A：${a.id}`)
  await until('A 的规格调用开始', () => callRunning(a.id, 'spec'))
  await sleep(3000)
  const killed = dshPids()
  for (const p of killed) process.kill(p, 'SIGKILL')
  note(`A：结掉了 dsh 进程 ${killed.join('、')}`)
  await until('A 失败', async () => (await detail(a.id)).status === 'failed', 5 * 60_000)
  const ra = await checkFailure(a.id, 'A（dsh 进程被结掉）')
  Object.assign(checks, ra.checks)
  await snap(a.id, 'A-failed')
  await post(`/api/tasks/${a.id}/retry`, {})
  note('A：点了重试')
  await until('A 重试后跑完', async () => ['done', 'failed'].includes((await detail(a.id)).status))
  checks['A：重试后任务跑完'] = (await detail(a.id)).status === 'done'
  results.A = { ...ra, killed, after: (await detail(a.id)).status }

  // B. 开发调用进行中删掉 worktree。
  const b = (await (await post('/api/tasks', { repo: REPO, workflow: 'standard', request: REQUEST })).json()) as { id: string }
  note(`任务 B：${b.id}`)
  await until('B 的开发调用开始', () => callRunning(b.id, 'build'))
  const wt = (await detail(b.id)).worktree
  rmSync(wt, { recursive: true, force: true })
  note(`B：删掉了 worktree ${wt}`)
  await until('B 失败', async () => (await detail(b.id)).status === 'failed', 10 * 60_000)
  const rb = await checkFailure(b.id, 'B（worktree 被删）')
  Object.assign(checks, rb.checks)
  await snap(b.id, 'B-failed')
  results.B = rb

  const processLog = join(DATA, 'logs', 'eos.log')
  checks['Web 服务进程的输出写进 logs/eos.log'] = existsSync(processLog) && /Eos Web：http/.test(readFileSync(processLog, 'utf8')) && readFileSync(processLog, 'utf8').includes(`[${a.id}]`)
} finally {
  await browser.close()
  process.kill(-server.pid!, 'SIGTERM')
}
const report = { commit, node: process.version, checks, results, shots }
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const passed = Object.values(checks).filter(Boolean).length
note(`${passed}/${Object.keys(checks).length} 通过`)
for (const [k, v] of Object.entries(checks)) note(`${v ? '✓' : '✗'} ${k}`)
