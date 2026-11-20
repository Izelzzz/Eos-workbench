import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquire } from '../src/runner/lock.ts'

const dir = () => mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-lock-'))

test('a second runner is refused while the first holds the lock, and admitted after release', () => {
  const d = dir()
  const first = acquire(d, 't1')
  assert.ok('release' in first)
  const second = acquire(d, 't1')
  assert.deepEqual(second, { heldBy: process.pid })
  first.release()
  assert.ok('release' in acquire(d, 't1'))
})

test('a lock left by a dead process is taken over', () => {
  const d = dir()
  writeFileSync(join(d, 't2.pid'), '999999999')
  assert.ok('release' in acquire(d, 't2'))
})

test('locks are per task', () => {
  const d = dir()
  assert.ok('release' in acquire(d, 'a'))
  assert.ok('release' in acquire(d, 'b'))
})

test('taking over a stale lock waits for whoever is already taking it over', () => {
  const d = dir()
  writeFileSync(join(d, 't3.pid'), '999999999')
  writeFileSync(join(d, 't3.takeover'), String(process.pid)) // 另一个活着的进程正在接管
  assert.deepEqual(acquire(d, 't3', 4242), { heldBy: process.pid })
  writeFileSync(join(d, 't3.takeover'), '999999998') // 接管者自己也死了
  const lock = acquire(d, 't3', 4242)
  assert.ok('release' in lock)
  assert.equal(readFileSync(join(d, 't3.pid'), 'utf8'), '4242')
  assert.equal(existsSync(join(d, 't3.takeover')), false, 'the guard is removed after the takeover')
})

test('a lock that was just created and is still empty is not mistaken for a dead holder', async () => {
  const d = dir()
  const lockModule = join(import.meta.dirname, '..', 'src', 'runner', 'lock.ts')
  // 子进程先加载好，等 go 文件出现才去抢锁；父进程放出 go 时锁文件还是空的，50ms 后才写入 pid。
  const code = `const { acquire } = await import(${JSON.stringify(lockModule)}); const { existsSync, writeFileSync } = await import('node:fs');
    writeFileSync(process.argv[1] + '/ready', ''); while (!existsSync(process.argv[1] + '/go')) {}
    console.log(JSON.stringify(acquire(process.argv[1], 'e', 4242)))`
  const out = new Promise<string>((resolve, reject) =>
    execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, d], (e, stdout) => (e ? reject(e) : resolve(stdout.trim()))))
  while (!existsSync(join(d, 'ready'))) await new Promise(r => setTimeout(r, 10))
  writeFileSync(join(d, 'e.pid'), '') // 另一个进程刚用 O_EXCL 建好锁，还没写入 pid
  writeFileSync(join(d, 'go'), '')
  await new Promise(r => setTimeout(r, 50))
  writeFileSync(join(d, 'e.pid'), String(process.pid))
  assert.deepEqual(JSON.parse(await out), { heldBy: process.pid }, 'waits for the pid instead of taking the lock over')
  assert.equal(readFileSync(join(d, 'e.pid'), 'utf8'), String(process.pid))
})

test('a lock left empty by a creator that crashed before writing is taken over after a short wait', () => {
  const d = dir()
  writeFileSync(join(d, 'z.pid'), '')
  const lock = acquire(d, 'z', 4242)
  assert.ok('release' in lock)
  assert.equal(readFileSync(join(d, 'z.pid'), 'utf8'), '4242')
})
