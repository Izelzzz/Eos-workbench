import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
