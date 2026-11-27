import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffLines, diffStat, fold } from '../src/workflow/diff.ts'

test('line diff keeps common lines and marks additions and deletions', () => {
  const d = diffLines('a\nb\nc', 'a\nc\nd')
  assert.deepEqual(d, [
    { kind: 'same', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'same', text: 'c' },
    { kind: 'add', text: 'd' },
  ])
  assert.deepEqual(diffStat(d), { add: 1, del: 1 })
  assert.deepEqual(diffLines('', 'x'), [{ kind: 'add', text: 'x' }])
  assert.deepEqual(diffStat(diffLines('same', 'same')), { add: 0, del: 0 })
})

test('unchanged lines far from any change fold into one skip line', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
  const after = before.replace('l10', 'L10')
  const f = fold(diffLines(before, after), 2)
  assert.deepEqual(
    f.map(l => (l.kind === 'skip' ? `skip${l.count}` : l.kind)),
    ['skip8', 'same', 'same', 'del', 'add', 'same', 'same', 'skip7'],
  )
})
