// 结束工作目录在某个目录里的进程（Linux /proc）。平台撤销越界改动之前调用（Izelzzz/Eos-workbench#28）：
// agent 这一轮留下的进程（例如用 nohup、setsid 脱离的）不能在平台撤销时继续改 worktree。
// 工作目录已经切到 worktree 外面的进程这里找不到；撤销时的删除另有防护（git.ts 的 safeRemove），删不到外面。
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'

/** 读 /proc 的几个操作。测试里换成假的，用来固定进程退出途中各个时刻的样子。 */
export type Procfs = {
  pids: () => number[]
  cwdOf: (pid: number) => string | undefined
  /** /proc/<pid>/stat 的内容；进程不存在时 undefined。 */
  stat: (pid: number) => string | undefined
  comm: (pid: number) => string
  kill: (pid: number) => void
}

const linux: Procfs = {
  pids: () => readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number).filter(p => p !== process.pid),
  cwdOf: pid => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '')
    } catch {
      return undefined
    }
  },
  stat: pid => {
    try {
      return readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch {
      return undefined
    }
  },
  comm: pid => {
    try {
      return readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    } catch {
      return '?'
    }
  },
  kill: pid => process.kill(pid, 'SIGKILL'),
}

/** stat 里进程名（可能带空格和括号）后面的字段：[0] 是状态，[17] 是线程数，[19] 是启动时间。 */
const fieldsAfterName = (stat: string): string[] => stat.slice(stat.lastIndexOf(')') + 2).split(' ')

/**
 * 被杀的进程是否已经退出：/proc 里没有了，变成僵尸（Z）而且别的线程都已退出，或者进程号已经被别的进程（启动时间不同）重新用了。
 * 多线程的进程（node 等）主线程可能先变成 Z，别的线程还在退出，所以还要看线程数。
 * 不能看工作目录：内核在进程退出途中先释放工作目录（exit_fs），之后才变成僵尸（exit_notify），
 * 中间这段时间里读不到工作目录、进程却还在。
 */
const exited = (proc: Procfs, pid: number, started: string): boolean => {
  const stat = proc.stat(pid)
  if (stat === undefined) return true
  const f = fieldsAfterName(stat)
  return f[19] !== started || ((f[0] === 'Z' || f[0] === 'X') && Number(f[17]) <= 1)
}

/** 默认最多等多久（毫秒）。 */
export const KILL_WAIT_MS = 2000

/**
 * 杀掉工作目录在 dir 里的全部进程，等它们真正退出（最多 waitMs），返回被杀的进程（号、名字、等到截止时有没有退出）。
 * 不是 Linux 时什么都不做。
 * 注意：用户自己的终端、编辑器只要工作目录在任务的 worktree 里也会被杀——不要在平台数据目录里的 worktree 里工作。
 */
export const killProcessesIn = async (dir: string, waitMs = KILL_WAIT_MS, proc: Procfs = linux): Promise<{ pid: number; name: string; exited: boolean }[]> => {
  if (proc === linux && process.platform !== 'linux') return []
  const root = realpathSync(dir)
  const isInside = (pid: number): boolean => {
    const cwd = proc.cwdOf(pid)
    return cwd !== undefined && (cwd === root || cwd.startsWith(root + sep))
  }
  const killed: { pid: number; name: string; started: string }[] = []
  for (const pid of proc.pids().filter(isInside)) {
    const name = proc.comm(pid)
    const started = (s => (s === undefined ? undefined : fieldsAfterName(s)[19]))(proc.stat(pid))
    // 已经不在了，或者读不出启动时间（没法判断之后看到的是不是它）：跳过。
    if (started === undefined) continue
    try {
      proc.kill(pid)
      killed.push({ pid, name, started })
    } catch {
      // 已经退出，或者不是平台用户的进程
    }
  }
  const deadline = Date.now() + waitMs
  const pending = () => killed.filter(k => !exited(proc, k.pid, k.started))
  while (Date.now() < deadline && pending().length > 0) await new Promise(r => setTimeout(r, 20))
  const left = new Set(pending().map(k => k.pid))
  return killed.map(({ pid, name }) => ({ pid, name, exited: !left.has(pid) }))
}
