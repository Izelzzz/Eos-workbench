// 真实临时仓库上的可写范围检查：越界的改动必须被撤销、不进提交，范围内的照常提交。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { changes, commitInScope, revertOutOfScope } from '../src/runner/git.ts'

/** 临时目录里的真实仓库，基线提交里有几个文件（含带空格的路径和嵌套目录）。 */
const repo = () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-git-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
  write(dir, 'README.md', '# demo\n')
  write(dir, 'src/a.ts', 'a\n')
  write(dir, 'src/deep/b.ts', 'b\n')
  write(dir, 'docs/changes.md', '# 改动\n')
  write(dir, 'docs/design.md', '# 设计\n')
  write(dir, 'a dir/with space.txt', 's\n')
  git('init', '-q', '-b', 'main', '.')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init')
  return { dir, git }
}

const write = (dir: string, path: string, content: string) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), content)
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8')
/** 最后一次提交里有改动的路径。 */
const committed = (git: (...a: string[]) => string) =>
  git('show', '--name-status', '--format=', 'HEAD').trim().split('\n').filter(l => l !== '').map(l => l.split('\t').slice(1).join(' → ')).sort()

test('changes 解析出改过、删掉、改名和新加（未跟踪）的路径，包括带空格的和嵌套目录里的', () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'src/a.ts'), 'a\nmod\n')
  rmSync(join(dir, 'docs/design.md'))
  git('mv', 'README.md', 'LISEZMOI.md')
  write(dir, 'src/new.ts', 'new\n')
  write(dir, 'out/deep/u.txt', 'x\n')
  write(dir, 'out/new space.txt', 'y\n')
  writeFileSync(join(dir, 'a dir/with space.txt'), 's\nmod\n')
  git('add', 'src/new.ts')
  assert.deepEqual(changes(dir).map(c => (c.from === undefined ? c.path : `${c.from} → ${c.path}`)).sort(), [
    'README.md → LISEZMOI.md', 'a dir/with space.txt', 'docs/design.md', 'out/deep/u.txt', 'out/new space.txt', 'src/a.ts', 'src/new.ts',
  ])
})

test('撤销越界改动：改过的还原、删掉的恢复、新加的删除、改名的两边都复原', () => {
  const { dir, git } = repo()
  // 范围内的改动。
  writeFileSync(join(dir, 'src/a.ts'), 'a\n范围内\n')
  write(dir, 'src/deep/c.ts', '范围内的新文件\n')
  write(dir, 'docs/changes.md', '# 改动\n写了点东西\n')
  // 越界的改动。
  writeFileSync(join(dir, 'docs/design.md'), '# 设计\n被改了\n')
  rmSync(join(dir, 'README.md'))
  write(dir, 'top.txt', '越界的新文件\n')
  write(dir, 'out/deep/u.txt', '越界的嵌套新文件\n')
  write(dir, 'out/new space.txt', '越界、带空格\n')
  writeFileSync(join(dir, 'a dir/with space.txt'), 's\n越界\n')
  git('mv', 'docs/design.md', 'docs/design2.md')

  const reverted = revertOutOfScope(dir, ['src/**', 'docs/changes.md'])
  assert.deepEqual(reverted, ['README.md', 'a dir/with space.txt', 'docs/design.md', 'docs/design2.md', 'out/deep/u.txt', 'out/new space.txt', 'top.txt'])
  assert.equal(read(dir, 'README.md'), '# demo\n', '删掉的越界文件恢复了')
  assert.equal(read(dir, 'docs/design.md'), '# 设计\n', '改名又改过内容的越界文件复原了')
  assert.equal(existsSync(join(dir, 'docs/design2.md')), false, '改名后的越界路径删掉了')
  assert.equal(read(dir, 'a dir/with space.txt'), 's\n', '带空格的越界路径还原了')
  for (const p of ['top.txt', 'out/deep/u.txt', 'out/new space.txt']) assert.equal(existsSync(join(dir, p)), false, `${p} 删掉了`)
  assert.equal(read(dir, 'src/a.ts'), 'a\n范围内\n', '范围内的改动没动')
  assert.equal(existsSync(join(dir, 'src/deep/c.ts')), true)
  assert.deepEqual(revertOutOfScope(dir, ['src/**', 'docs/changes.md']), [], '重复调用不再撤销任何东西')
})

test('commitInScope 只提交范围内的改动，并返回被撤销的越界路径', () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'src/a.ts'), 'a\n范围内\n')
  write(dir, 'src/deep/c.ts', '新文件\n')
  write(dir, 'docs/design.md', '越界\n')
  write(dir, 'top.txt', '越界\n')
  const first = commitInScope(dir, ['src/**'], 'eos: build produce (c1)')
  assert.notEqual(first.sha, undefined)
  assert.deepEqual(first.reverted, ['docs/design.md', 'top.txt'])
  assert.deepEqual(committed(git), ['src/a.ts', 'src/deep/c.ts'], '提交里只有范围内的改动')
  assert.equal(git('status', '--porcelain').trim(), '', '撤销之后 worktree 是干净的')

  // 只有越界改动时：撤销掉，没有东西可提交。
  write(dir, 'top.txt', '又越界了\n')
  const second = commitInScope(dir, ['src/**'], 'eos: build fix (c2)')
  assert.deepEqual([second.sha, second.reverted], [undefined, ['top.txt']])
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2', '没有产生空提交')
})

test('writePaths 为 ** 时和原来一样提交全部改动；只读角色（空列表）什么都提交不了', () => {
  const { dir, git } = repo()
  write(dir, 'anywhere/x.txt', 'x\n')
  writeFileSync(join(dir, 'README.md'), '# 改过\n')
  const all = commitInScope(dir, ['**'], 'eos: build produce (c1)')
  assert.deepEqual(all.reverted, [])
  assert.deepEqual(committed(git), ['README.md', 'anywhere/x.txt'])

  write(dir, 'readonly.txt', 'x\n')
  const none = commitInScope(dir, [], 'eos: review critique (c2)')
  assert.deepEqual([none.sha, none.reverted], [undefined, ['readonly.txt']])
  assert.equal(git('rev-list', '--count', 'HEAD').trim(), '2')
})

test('文件名里的通配符按字面量处理，不会连带撤销别的文件', () => {
  const { dir, git } = repo()
  write(dir, 'src/keep[1].ts', '原样\n')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'add bracket')
  // 越界的文件名带 * 和 []，范围内有一个名字会被通配符命中的文件。
  write(dir, 'keep[1].txt', '越界\n')
  write(dir, 'k*.txt', '越界\n')
  write(dir, 'src/a.ts', 'a\n范围内\n')
  const r = commitInScope(dir, ['src/**'], 'eos: build produce (c1)')
  assert.deepEqual(r.reverted, ['k*.txt', 'keep[1].txt'])
  assert.equal(existsSync(join(dir, 'keep[1].txt')), false)
  assert.equal(existsSync(join(dir, 'k*.txt')), false)
  assert.equal(read(dir, 'src/keep[1].ts'), '原样\n', '范围内同名风格的文件没被动')
  assert.deepEqual(committed(git), ['src/a.ts'])
})

test('agent 自己 git add 过的越界改动也会被撤销，不会留在暂存区', () => {
  const { dir, git } = repo()
  write(dir, 'src/a.ts', 'a\n范围内\n')
  write(dir, 'top.txt', '越界\n')
  rmSync(join(dir, 'docs/design.md'))
  git('add', '-A')
  const r = commitInScope(dir, ['src/**'], 'eos: build produce (c1)')
  assert.deepEqual(r.reverted, ['docs/design.md', 'top.txt'])
  assert.deepEqual(committed(git), ['src/a.ts'])
  assert.equal(read(dir, 'docs/design.md'), '# 设计\n')
})
