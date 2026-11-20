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

const readPid = (file: string): number | undefined => {
  try {
    return Number(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 用 O_EXCL 创建文件；已存在返回 false。 */
const create = (file: string, pid: number): boolean => {
  try {
    writeFileSync(file, String(pid), { flag: 'wx' })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw e
  }
}

/**
 * 拿到锁返回 Lock；被另一个活着的进程持有时返回它的 pid。
 * 接管过期的锁要先独占拿到 <id>.takeover：只有它的持有者能删除过期的锁，
 * 两个进程同时发现锁过期时，不会出现一个删掉另一个刚建好的新锁、结果两边都在跑的情况。
 */
export const acquire = (dir: string, id: string, pid = process.pid): Lock | { heldBy: number } => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.pid`)
  const guard = join(dir, `${id}.takeover`)
  const lock = (): Lock => ({ release: () => rmSync(file, { force: true }) })
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(file, pid)) return lock()
    const current = readPid(file)
    if (current !== undefined && alive(current)) return { heldBy: current }
    if (!create(guard, pid)) {
      const taker = readPid(guard)
      if (taker !== undefined && alive(taker)) return { heldBy: taker }
      rmSync(guard, { force: true }) // 接管的进程自己也死了：清掉它的保护文件再来
      continue
    }
    try {
      // 拿到保护文件后再确认一次：锁仍然属于那个已经退出的进程，才删除它。
      const again = readPid(file)
      if (again !== undefined && alive(again)) return { heldBy: again }
      rmSync(file, { force: true })
      if (create(file, pid)) return lock()
      const winner = readPid(file)
      return { heldBy: winner ?? -1 }
    } finally {
      rmSync(guard, { force: true })
    }
  }
  return { heldBy: readPid(file) ?? -1 }
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
