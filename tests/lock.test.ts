import assert from 'node:assert/strict'
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

test('six processes racing for the same stale lock: exactly one wins, every round', async () => {
  const { spawn } = await import('node:child_process')
  const lockModule = join(import.meta.dirname, '..', 'src', 'runner', 'lock.ts')
  const child = `const { acquire } = await import(${JSON.stringify(lockModule)}); const r = acquire(process.argv[1], 't'); console.log('release' in r ? 'won' : 'lost'); if ('release' in r) await new Promise(x => setTimeout(x, 2000))`
  for (let round = 0; round < 5; round++) {
    const d = dir()
    writeFileSync(join(d, 't.pid'), '999999999') // 上一个 runner 被 SIGKILL 后留下的锁
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>(resolve => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child, d], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      p.stdout.on('data', c => (out += c))
      p.on('exit', () => resolve(out.trim()))
    })))
    assert.equal(results.filter(r => r === 'won').length, 1, `round ${round}: ${results.join(',')}`)
  }
})
