// 撤销前结束 agent 留下的进程（Izelzzz/Eos-workbench#28）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { killProcessesIn } from '../src/runner/procs.ts'

/** 进程还在运行：/proc 里有它、而且不是僵尸（Z）。被杀的子进程在被回收之前是僵尸，kill(pid, 0) 仍然成功，不能用它判断。 */
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    return false
  }
}

test('processes whose working directory is inside the worktree are killed, detached or not; others are left alone', { skip: process.platform !== 'linux' }, async () => {
  const base = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-procs-'))
  const wt = join(base, 'wt')
  mkdirSync(join(wt, 'deep'), { recursive: true })
  const outside = join(base, 'elsewhere')
  mkdirSync(outside)
  const start = (cmd: string[], cwd: string) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { cwd, detached: true, stdio: 'ignore' })
    p.unref()
    return p.pid!
  }
  const plain = start(['sleep', '60'], wt)
  const nested = start(['sleep', '60'], join(wt, 'deep'))
  const setsid = start(['setsid', 'sleep', '60'], wt)
  const other = start(['sleep', '60'], outside)
  await new Promise(r => setTimeout(r, 200))
  const killed = await killProcessesIn(wt)
  // setsid 在这里是进程组组长，会先 fork 再在新会话里执行 sleep：sleep 的进程号不是 setsid 的，事先不知道。
  // 按工作目录找就能找到它：被杀的应该正好是 plain、nested 和这个脱离出去的 sleep。
  assert.ok(killed.includes(plain) && killed.includes(nested), `killed ${killed.join(',')}`)
  const detached = killed.filter(p => p !== plain && p !== nested)
  assert.equal(detached.length, 1, `the setsid-detached sleep (setsid was ${setsid}) is found by its working directory`)
  for (const pid of killed) assert.equal(alive(pid), false)
  assert.equal(alive(other), true, 'a process outside the worktree is not touched')
  process.kill(other, 'SIGKILL')
  assert.deepEqual(await killProcessesIn(wt), [], 'nothing left in the worktree')
})
