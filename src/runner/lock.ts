// 每个任务同一时间只允许一个 runner。锁文件用 O_EXCL 原子创建，里面写着 pid；持有者已经不在就接管。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export type Lock = { release: () => void }

/** 拿到锁返回 Lock；被另一个活着的进程持有时返回它的 pid。 */
export const acquire = (dir: string, id: string, pid = process.pid): Lock | { heldBy: number } => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.pid`)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(pid), { flag: 'wx' })
      return { release: () => rmSync(file, { force: true }) }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = Number(readFileSync(file, 'utf8'))
      if (alive(holder)) return { heldBy: holder }
      rmSync(file, { force: true }) // 持有者已退出（例如被 SIGKILL），清掉再试一次
    }
  }
  return { heldBy: Number(readFileSync(file, 'utf8')) }
}

/** 当前持有锁、而且还活着的进程 pid；没有就返回 undefined。只读，不清理过期的锁。 */
export const holder = (dir: string, id: string): number | undefined => {
  try {
    const pid = Number(readFileSync(join(dir, `${id}.pid`), 'utf8'))
    return alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}
