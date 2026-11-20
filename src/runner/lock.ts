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

const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 空文件最多等这么久：别的进程用 O_EXCL 建好文件、还没写入 pid 的那一瞬间，文件是空的。 */
const EMPTY_WAIT_MS = 1000

/**
 * 读锁文件里的 pid。文件不存在返回 undefined。读到空文件时先等它写完，
 * 不能把"刚创建、还没写入"当成"持有者已死"；等了 1 秒仍是空的，才当作创建者在写入前就崩溃了（返回 0）。
 */
const readPid = (file: string): number | undefined => {
  for (let waited = 0; ; waited += 10) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
    if (text.trim() !== '') return Number(text)
    if (waited >= EMPTY_WAIT_MS) return 0
    nap(10)
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
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(file, pid)) return lock()
    const current = readPid(file)
    if (current === undefined) continue // 刚被持有者释放：再试一次创建
    if (alive(current)) return { heldBy: current }
    if (!create(guard, pid)) {
      const taker = readPid(guard)
      if (taker === undefined) continue // 接管刚结束：再看一次锁
      if (alive(taker)) return { heldBy: taker }
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
