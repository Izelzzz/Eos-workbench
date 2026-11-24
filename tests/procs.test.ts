// 撤销前结束 agent 留下的进程（Izelzzz/Eos-workbench#28）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { killProcessesIn, type Procfs } from '../src/runner/procs.ts'

/**
 * 进程还在运行：/proc 里有它、而且不是僵尸（Z）或正在被回收（X）。和 killProcessesIn 判断「已退出」用同样的状态。
 * 被杀的子进程在被回收之前是僵尸，kill(pid, 0) 仍然成功，不能用它判断。
 */
const alive = (pid: number) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3))
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
  const killed = (await killProcessesIn(wt)).map(k => k.pid)
  // setsid 在这里是进程组组长，会先 fork 再在新会话里执行 sleep：sleep 的进程号不是 setsid 的，事先不知道。
  // 按工作目录找就能找到它：被杀的应该正好是 plain、nested 和这个脱离出去的 sleep。
  assert.ok(killed.includes(plain) && killed.includes(nested), `killed ${killed.join(',')}`)
  const detached = killed.filter(p => p !== plain && p !== nested)
  assert.equal(detached.length, 1, `the setsid-detached sleep (setsid was ${setsid}) is found by its working directory`)
  for (const pid of killed) assert.equal(alive(pid), false)
  assert.equal(alive(other), true, 'a process outside the worktree is not touched')
  process.kill(other, 'SIGKILL')
  assert.deepEqual(await killProcessesIn(wt), [], 'nothing left in the worktree')
  rmSync(base, { recursive: true, force: true })
})

/**
 * 假的 /proc：一个工作目录在 /wt 里的进程。被杀后依次经过：工作目录还在（R）→ 工作目录已释放但还没变成僵尸（R）→ 僵尸（Z）。
 * 第二段就是内核 exit_fs 之后、exit_notify 之前；CI 上「processes whose working directory is inside the worktree are killed…」偶发失败时，等待循环正是在这一段提前返回的。
 */
const fakeProc = (stages: ('inside' | 'cwd-gone' | 'zombie' | 'zombie-leader' | 'gone')[], started = '4242') => {
  let polls = 0
  let killedAt: number | undefined
  const stage = () => (killedAt === undefined ? 'inside' : stages[Math.min(polls - killedAt, stages.length - 1)]!)
  // 进程名后面依次是状态、16 个别的字段、线程数、1 个字段、启动时间。
  const stat = (state: string, threads: number) => `77 (sl eep) ${state} ${Array.from({ length: 16 }, () => '0').join(' ')} ${threads} 0 ${started} 0`
  const proc: Procfs = {
    pids: () => (stage() === 'gone' ? [] : [77]),
    // 读工作目录和读 stat 都算查了一次：不管等待条件看哪一个，假进程都按查询的次数往下走。
    cwdOf: () => {
      polls++
      return stage() === 'inside' ? '/wt' : undefined
    },
    stat: () => {
      polls++
      const s = stage()
      return s === 'gone' ? undefined : stat(s === 'zombie' || s === 'zombie-leader' ? 'Z' : 'R', s === 'zombie-leader' ? 4 : 1)
    },
    comm: () => 'sleep',
    kill: () => { killedAt = polls },
  }
  return { proc, polls: () => polls }
}

test('the wait does not end while a killed process has released its working directory but is not yet a zombie', async () => {
  const { proc, polls } = fakeProc(['inside', 'cwd-gone', 'cwd-gone', 'cwd-gone', 'zombie'])
  const killed = await killProcessesIn('/', 2000, { ...proc, cwdOf: pid => (proc.cwdOf(pid) === '/wt' ? '/' : undefined) })
  assert.deepEqual(killed, [{ pid: 77, name: 'sleep', exited: true }])
  assert.ok(polls() >= 5, `等到变成僵尸才返回（查了 ${polls()} 次）`)
})

test('a killed process that is still running at the deadline is reported as not exited', async () => {
  const { proc } = fakeProc(['inside', 'cwd-gone'])
  const killed = await killProcessesIn('/', 100, { ...proc, cwdOf: pid => (proc.cwdOf(pid) === '/wt' ? '/' : undefined) })
  assert.deepEqual(killed, [{ pid: 77, name: 'sleep', exited: false }])
})

test('a process number reused by a new process (different start time) counts as exited', async () => {
  const { proc } = fakeProc(['inside', 'cwd-gone'])
  let reused = false
  const killed = await killProcessesIn('/', 2000, {
    ...proc,
    cwdOf: pid => (proc.cwdOf(pid) === '/wt' ? '/' : undefined),
    kill: pid => { proc.kill(pid); reused = true },
    stat: pid => { const s = proc.stat(pid); return reused && s !== undefined ? s.replace(' 4242 ', ' 9999 ') : s },
  })
  assert.deepEqual(killed, [{ pid: 77, name: 'sleep', exited: true }])
})

test('a multi-threaded process whose main thread is a zombie but other threads are still exiting has not exited yet', async () => {
  const { proc, polls } = fakeProc(['inside', 'zombie-leader', 'zombie-leader', 'zombie-leader', 'zombie'])
  const killed = await killProcessesIn('/', 2000, { ...proc, cwdOf: pid => (proc.cwdOf(pid) === '/wt' ? '/' : undefined) })
  assert.deepEqual(killed, [{ pid: 77, name: 'sleep', exited: true }])
  assert.ok(polls() >= 5, `等到别的线程也退出才返回（查了 ${polls()} 次）`)
})
