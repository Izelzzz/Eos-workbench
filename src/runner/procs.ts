// 结束工作目录在某个目录里的进程（Linux /proc）。平台撤销越界改动之前调用（Izelzzz/Eos-workbench#28）：
// agent 这一轮留下的进程（例如用 nohup、setsid 脱离的）不能在平台撤销时继续改 worktree。
// 工作目录已经切到 worktree 外面的进程这里找不到；撤销时的删除另有防护（git.ts 的 safeRemove），删不到外面。
import { readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'

const cwdOf = (pid: number): string | undefined => {
  try {
    return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, '')
  } catch {
    return undefined
  }
}

const inside = (root: string) => (pid: number): boolean => {
  const cwd = cwdOf(pid)
  return cwd !== undefined && (cwd === root || cwd.startsWith(root + sep))
}

const pids = (): number[] => readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number).filter(p => p !== process.pid)

/** 杀掉工作目录在 dir 里的全部进程，等它们退出（最多 waitMs），返回被杀的进程号。不是 Linux 时什么都不做。 */
export const killProcessesIn = async (dir: string, waitMs = 2000): Promise<number[]> => {
  if (process.platform !== 'linux') return []
  const root = realpathSync(dir)
  const isInside = inside(root)
  const killed: number[] = []
  for (const pid of pids().filter(isInside)) {
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // 已经退出，或者不是平台用户的进程
    }
  }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && pids().some(p => killed.includes(p) && isInside(p))) await new Promise(r => setTimeout(r, 20))
  return killed
}
