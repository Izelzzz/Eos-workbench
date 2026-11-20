import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchGlob, matchesAny } from '../src/workflow/glob.ts'

/** [glob, 匹配的路径, 不匹配的路径] */
const CASES: [string, string[], string[]][] = [
  ['src/**', ['src', 'src/a.ts', 'src/a/b/c.ts', 'src/有中文.ts'], ['srcs/a.ts', 'a/src/b.ts', 'docs/a.md', 'source.ts']],
  ['**', ['a', 'a/b', 'a/b/c.ts', 'docs/changes.md'], []],
  ['docs/changes.md', ['docs/changes.md', './docs/changes.md'], ['docs/changes.mdx', 'docs/a/changes.md', 'changes.md', 'DOCS/changes.md']],
  ['*.md', ['a.md', 'README.md'], ['docs/a.md', 'a.mdx', 'a.md/b']],
  ['**/*.md', ['a.md', 'docs/a.md', 'docs/deep/a.md'], ['a.txt', 'docs/a.md.bak']],
  ['src/*.ts', ['src/a.ts', 'src/a-b.ts'], ['src/a/b.ts', 'src/a.tsx', 'src/a.ts/b']],
  ['src/*/index.ts', ['src/a/index.ts'], ['src/index.ts', 'src/a/b/index.ts']],
  ['test?.ts', ['test1.ts', 'testa.ts'], ['test.ts', 'test12.ts']],
  ['tests/', ['tests', 'tests/a.test.ts', 'tests/deep/a.ts'], ['tests.ts', 'a/tests/b.ts']],
  ['a dir/**', ['a dir/with space.txt'], ['a dir2/x.txt', 'adir/x.txt']],
  ['**/node_modules/**', ['node_modules', 'node_modules/x/y.js', 'web/node_modules/x.js'], ['node_module/x.js', 'x/node_modulesy/z.js']],
  ['src/**/*.ts', ['src/a.ts', 'src/a/b.ts'], ['src/a.md', 'lib/a.ts']],
]

test('glob 按路径段匹配：** 跨段，* 和 ? 只在一个段内', () => {
  for (const [pattern, yes, no] of CASES) {
    for (const p of yes) assert.equal(matchGlob(pattern, p), true, `${pattern} 应该匹配 ${p}`)
    for (const p of no) assert.equal(matchGlob(pattern, p), false, `${pattern} 不应该匹配 ${p}`)
  }
})

test('matchesAny：任意一个 glob 命中就算允许，空列表什么都不允许', () => {
  const allowed = ['src/**', 'docs/changes.md']
  assert.equal(matchesAny(allowed, 'src/a/b.ts'), true)
  assert.equal(matchesAny(allowed, 'docs/changes.md'), true)
  assert.equal(matchesAny(allowed, 'docs/other.md'), false)
  assert.equal(matchesAny([], 'src/a.ts'), false, '只读角色什么都不能写')
  assert.equal(matchesAny(['**'], 'any/deep/path.txt'), true, '默认范围能写整个 worktree')
})

test('glob 不会把 * 当成跨段通配，也不会漏掉结尾的段', () => {
  assert.equal(matchGlob('src/*', 'src/a/b.ts'), false)
  assert.equal(matchGlob('src/*', 'src'), false, 'src/* 需要 src 下面有一个段')
  assert.equal(matchGlob('src', 'src/a.ts'), false, '写一个具体路径不等于它下面的全部')
  assert.equal(matchGlob('src/**', 'src/'), true, '结尾的斜杠不影响')
})
