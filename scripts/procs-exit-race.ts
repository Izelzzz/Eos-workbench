// 复现 killProcessesIn 的等待条件问题：进程被 SIGKILL 后，内核先释放它的工作目录（/proc/<pid>/cwd 读不到），
// 之后才变成僵尸（Z）。等待循环只看「工作目录还在不在目录里」，可能在进程还没退出完时就返回。
// 用法：node --import tsx scripts/procs-exit-race.ts [轮数=200] [每轮进程数=8] [加负载的 worker 数=CPU 核数] [sleep|node]
// 每轮：在临时目录里起若干进程，killProcessesIn 返回后立刻看它们是否还活着（/proc 里有、而且不是 Z），统计没退出完的。
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { killProcessesIn } from '../src/runner/procs.ts'

const [rounds = 200, perRound = 8, load = availableParallelism()] = process.argv.slice(2, 5).map(Number)
/** 被杀的进程：sleep（退出很快），或者 node（多线程、占几百 MB 内存，退出时要做的事多）。 */
const kind = process.argv[5] ?? 'sleep'
const cmd = kind === 'node' ? [process.execPath, '-e', 'const b = Buffer.alloc(300e6, 1); setInterval(() => b[0]++, 1000)'] : ['sleep', '60']

const state = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3)
  } catch {
    return undefined
  }
}

const workers = Array.from({ length: load }, () => new Worker('for (;;) {}', { eval: true }))
const base = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-procs-race-'))
let stillAlive = 0
let total = 0
const states = new Map<string, number>()
try {
  for (let i = 0; i < rounds; i++) {
    const dir = join(base, `r${i}`)
    mkdirSync(dir)
    for (let j = 0; j < perRound; j++) spawn(cmd[0]!, cmd.slice(1), { cwd: dir, detached: true, stdio: 'ignore' }).unref()
    await new Promise(r => setTimeout(r, kind === 'node' ? 400 : 30))
    const killed = await killProcessesIn(dir)
    for (const { pid } of killed) {
      total++
      const s = state(pid)
      if (s !== undefined && s !== 'Z') {
        stillAlive++
        states.set(s, (states.get(s) ?? 0) + 1)
      }
    }
  }
} finally {
  for (const w of workers) void w.terminate()
  rmSync(base, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ rounds, perRound, load, kind, killed: total, notExitedWhenReturned: stillAlive, states: Object.fromEntries(states) })}\n`)
