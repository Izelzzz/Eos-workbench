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

// —— 独立审查发现的绕过（A1–A4），每条都先复现、再证明已经关上 ——

test('一个文件名不是合法 UTF-8 的越界文件：被按原始字节删掉，不进提交（原来会记成"已撤销"却被提交）', () => {
  const { dir, git } = repo()
  writeFileSync(Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x62, 0xff, 0x2e, 0x74, 0x78, 0x74])]), 'x\n')
  write(dir, 'src/ok.ts', 'ok\n')
  const r = commitInScope(dir, ['src/**'], 'm')
  assert.deepEqual(r.reverted, ['b\\xff.txt'])
  assert.deepEqual(committed(git), ['src/ok.ts'])
  assert.equal(git('status', '--porcelain'), '', 'the bad file is gone from the worktree too')
})

test('已跟踪的非 UTF-8 文件名撤销不了：拒绝提交，而不是悄悄提交', () => {
  const { dir, git } = repo()
  const bad = Buffer.concat([Buffer.from(dir + '/'), Buffer.from([0x62, 0xff])])
  writeFileSync(bad, 'v1\n')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'base has a bad name')
  const before = git('rev-parse', 'HEAD')
  writeFileSync(bad, 'v2\n')
  assert.throws(() => commitInScope(dir, ['src/**'], 'm'), /有越界改动撤销不了，没有提交/)
  assert.equal(git('rev-parse', 'HEAD'), before)
})

test('文件名里的反斜杠不是目录分隔符：根目录下名为 src\\evil.ts 的文件不在 src/** 里', () => {
  const { dir, git } = repo()
  writeFileSync(join(dir, 'src\\evil.ts'), 'evil\n')
  const r = commitInScope(dir, ['src/**'], 'm')
  assert.deepEqual(r.reverted, ['src\\evil.ts'])
  assert.equal(r.sha, undefined, 'nothing in scope to commit')
  assert.equal(existsSync(join(dir, 'src\\evil.ts')), false)
})

test('嵌套的 git 仓库（未跟踪目录）一律越界：整个删掉，不报错，也不会以 gitlink 提交', () => {
  const { dir, git } = repo()
  for (const where of ['evil', 'src/vendored']) {
    mkdirSync(join(dir, where), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: join(dir, where) })
    writeFileSync(join(dir, where, 'x.txt'), 'x\n')
  }
  const r = commitInScope(dir, ['src/**'], 'm')
  assert.deepEqual(r.reverted, ['evil/', 'src/vendored/'])
  assert.equal(existsSync(join(dir, 'evil')), false)
  assert.equal(existsSync(join(dir, 'src/vendored')), false)
  assert.equal(git('status', '--porcelain'), '')
})

test('worktree 的 .git 被换成 agent 自己的仓库：平台不执行 git，fsmonitor 和 hooks 都不会被触发', () => {
  const base = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-gitlink-'))
  const main = join(base, 'main')
  mkdirSync(main)
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' })
  g(main, 'init', '-q', '-b', 'main')
  g(main, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init')
  const wt = join(base, 'wt')
  g(main, 'worktree', 'add', '-q', '-b', 'eos/t', wt)
  write(wt, 'src/a.ts', 'a\n')
  assert.equal(commitInScope(wt, ['src/**'], 'ok', main).reverted.length, 0, 'an intact worktree commits normally')

  // agent 的手法：删掉 .git 文件，换成自己的仓库，配置 fsmonitor 让平台的 git status 执行命令。
  const pwned = join(base, 'PWNED')
  rmSync(join(wt, '.git'))
  g(wt, 'init', '-q')
  g(wt, 'config', 'core.fsmonitor', `touch ${pwned}; false`)
  write(wt, 'src/b.ts', 'b\n')
  assert.throws(() => commitInScope(wt, ['src/**'], 'm', main), /worktree 的 \.git 被改动过/)
  assert.equal(existsSync(pwned), false, 'the agent’s fsmonitor command never ran')
})
