// 撤销前结束 agent 留下的进程（Izelzzz/Eos-workbench#28）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { killProcessesIn } from '../src/runner/procs.ts'

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
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
  // setsid 不是进程组组长时直接 exec，进程号就是 sleep 的；它在新的会话里，但工作目录还在 worktree 里。
  assert.ok([plain, nested, setsid].every(p => killed.includes(p)), `killed ${killed.join(',')}`)
  for (const pid of [plain, nested, setsid]) assert.equal(alive(pid), false)
  assert.equal(alive(other), true, 'a process outside the worktree is not touched')
  process.kill(other, 'SIGKILL')
  assert.deepEqual(await killProcessesIn(wt), [], 'nothing left in the worktree')
})
