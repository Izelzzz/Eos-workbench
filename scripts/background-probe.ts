// 后台作业探针（Izelzzz/Eos-workbench#28）：真实 dsh + 真实模型，可写角色的能力面（background: false）。
// 让 agent 分别试：用 run_in_background 起后台作业、列出作业、用 nohup 在一条前台命令里把进程放到后台并记下进程号。
// 然后做平台撤销前会做的事（关掉这个 worktree 的 dsh 进程，杀掉工作目录在 worktree 里的进程），核对：
// - 工具表里没有 job_* 工具（来自会话日志里真正发给模型的工具表）；
// - run_in_background 被拒绝（会话日志里 bash 调用的结果）；
// - nohup 放到后台的进程在清理之后不在了；
// - 关掉再重启 dsh、续接会话要多久。
// 用法：node --import tsx scripts/background-probe.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor } from '../src/executor/dsh.ts'
import type { AgentProfile } from '../src/executor/types.ts'
import { killProcessesIn } from '../src/runner/procs.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'background-probe')
rmSync(OUT, { recursive: true, force: true })
const repo = join(OUT, 'repo')
const wt = join(OUT, 'wt')
mkdirSync(repo, { recursive: true })
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
g(repo, 'init', '-q', '-b', 'main')
g(repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init')
g(repo, 'worktree', 'add', '-q', '-b', 'eos/probe', wt)

const ex = new DshExecutor({
  dshHome: join(OUT, 'dsh'), dshBin: join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' },
})
const profile: AgentProfile = { denyTools: [], skills: [], mcp: [], background: false }
const spec = { model: 'deepseek-flash', write: 'worktree' as const, cwd: wt, profile }
const pidFile = join(wt, 'bg.pid')
const prompt = `这是一次后台进程的探针，请按顺序做，某一步失败也继续，最后逐条报告结果和错误原文：
1. 用 bash 工具执行 sleep 300，并把 run_in_background 参数设为 true。
2. 如果有 job_list 工具就调用它；没有就说没有。
3. 用 bash 工具执行：nohup sleep 301 > /dev/null 2>&1 & echo $! > ${pidFile}; echo started`

const isAlive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return false
  }
}

let report: Record<string, unknown> = {}
try {
  const reply = await ex.send({ key: 'probe/build', nonce: 'probe/c1', prompt, spec, ask: async () => '继续' })
  const offered = ex.toolsOffered('probe/build')
  const log = JSON.stringify((ex as unknown as { readLog: (id: string) => unknown[] }).readLog.call(ex, (await import('../src/executor/dsh.ts')).sessionIdFor('probe/build')))
  const bgPid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : undefined
  const aliveBefore = bgPid !== undefined && isAlive(bgPid)

  // 平台撤销前做的事：关掉 dsh 进程，杀掉工作目录在 worktree 里的进程。
  const t0 = Date.now()
  await ex.release(wt)
  const killed = await killProcessesIn(wt)
  const cleanupMs = Date.now() - t0
  const aliveAfter = bgPid !== undefined && isAlive(bgPid)

  // 下一次调用：重新启动 dsh、续接会话。
  const t1 = Date.now()
  const again = await ex.send({ key: 'probe/build', nonce: 'probe/c2', prompt: '只回复：好的', spec, ask: async () => '继续' })
  const restartMs = Date.now() - t1

  const checks = {
    '工具表里没有 job_* 工具': offered.length > 0 && !offered.some(t => t.startsWith('job_')),
    'bash 的 run_in_background 被拒绝': /run_in_background is disabled|JOB_BACKGROUND_DISABLED/.test(log),
    'nohup 放到后台的进程在本轮结束时还活着（证明它确实脱离了前台命令）': aliveBefore,
    '清理之后这个进程不在了': bgPid !== undefined && !aliveAfter,
    '清理后下一次调用正常（重启 dsh、续接会话）': again.text.length > 0,
  }
  const here = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
  report = {
    code: { commit: here('rev-parse', '--short', 'HEAD'), uncommitted: here('status', '--porcelain', '--', 'src', 'scripts', 'package.json').split('\n').filter(Boolean) },
    allOk: Object.values(checks).every(Boolean), checks, bgPid, killed, cleanupMs, restartMs, toolsOffered: offered, reply: reply.text,
  }
} finally {
  await ex.close()
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
process.exit(report.allOk === true ? 0 : 1)
