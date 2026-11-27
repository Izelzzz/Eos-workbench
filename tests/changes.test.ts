import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { hunks, MAX_DIFF_CHARS, MAX_DIFF_LINES, truncate } from '../src/runner/changes.ts'
import { committedChanges, createWorktree, fileDiff, filesByCall, MAX_DIFF_BYTES, onBranch } from '../src/runner/git.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { Credentials } from '../src/credentials/store.ts'
import { createWebServer } from '../src/web/server.ts'
import type { FileDiff, TaskChanges, TaskDetail } from '../src/web/types.ts'
import { FakeExecutor } from './fake-executor.ts'
import { workflow } from './helpers.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-changes-'))
  dirs.push(d)
  return d
}
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], { cwd, encoding: 'utf8' }).trim()

/** 一个仓库和任务 worktree：基线有几个文件，任务分支上提交了各种改动。 */
const setup = () => {
  const dir = tmp()
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'a.js'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, 'old name.txt'), 'same content that is long enough to be detected as a rename\n'.repeat(5))
  writeFileSync(join(repo, 'gone.txt'), 'bye\n')
  writeFileSync(join(repo, 'link'), 'a regular file\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const w = createWorktree(repo, dir, 't1')
  writeFileSync(join(w.worktree, 'src', 'a.js'), 'one\nTWO\nthree\n')
  git(w.worktree, 'mv', 'old name.txt', '新\t名.txt')
  git(w.worktree, 'rm', '-q', 'gone.txt')
  writeFileSync(join(w.worktree, 'src', 'b.js'), 'export const b = 1\n')
  writeFileSync(join(w.worktree, 'empty.py'), '')
  writeFileSync(join(w.worktree, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]))
  writeFileSync(join(w.worktree, 'big.txt'), Array.from({ length: MAX_DIFF_LINES + 10 }, (_, i) => `line ${i}`).join('\n') + '\n')
  rmSync(join(w.worktree, 'link'))
  symlinkSync('src/a.js', join(w.worktree, 'link'))
  git(w.worktree, 'add', '-A')
  git(w.worktree, 'commit', '-q', '-m', 'work')
  return { dir, repo, w, head: git(w.worktree, 'rev-parse', 'HEAD') }
}

test('按文件列出任务分支相对基线的改动：状态和增删行数；改名、二进制、空文件、路径里的 tab 和中文都对；列表不带 diff', () => {
  const { w, head } = setup()
  const c = committedChanges(w)
  assert.deepEqual([c.base, c.head, c.omitted], [w.baseSha, head, 0])
  const by = new Map(c.files.map(f => [f.path, f]))
  assert.deepEqual([...by.keys()].sort(), ['big.txt', 'empty.py', 'gone.txt', 'link', 'logo.png', 'src/a.js', 'src/b.js', '新\t名.txt'].sort())
  assert.deepEqual(by.get('src/a.js'), { path: 'src/a.js', status: 'modified', add: 1, del: 1, binary: false })
  assert.equal(by.get('src/b.js')?.status, 'added')
  assert.deepEqual([by.get('gone.txt')?.status, by.get('gone.txt')?.del], ['deleted', 1])
  assert.deepEqual(by.get('新\t名.txt'), { path: '新\t名.txt', from: 'old name.txt', status: 'renamed', add: 0, del: 0, binary: false })
  assert.equal(by.get('logo.png')?.binary, true)
  assert.deepEqual([by.get('empty.py')?.status, by.get('empty.py')?.add], ['added', 0])
})

test('单个文件的 diff 只留 @@ 段：文件换成符号链接时两段都没有头部行；二进制和只改名的没有内容', () => {
  const { w, head } = setup()
  assert.deepEqual(fileDiff(w, head, 'src/a.js'), { diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three' })
  assert.deepEqual(fileDiff(w, head, 'src/b.js'), { diff: '@@ -0,0 +1 @@\n+export const b = 1' })
  const link = fileDiff(w, head, 'link')!.diff
  assert.deepEqual(link.split('\n').filter(l => l.startsWith('@@')).length, 2, '删除一段、新增一段')
  assert.doesNotMatch(link, /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/m)
  assert.deepEqual(fileDiff(w, head, 'logo.png'), { diff: '' })
  assert.deepEqual(fileDiff(w, head, '新\t名.txt'), { diff: '' })
  assert.equal(fileDiff(w, head, 'not-changed.txt'), undefined)
})

test('过长的 diff 按行数和字数截断，并记下原来的大小', () => {
  const { w, head } = setup()
  const big = fileDiff(w, head, 'big.txt')!
  assert.equal(big.diff.split('\n').length, MAX_DIFF_LINES)
  assert.deepEqual(big.truncated !== undefined && 'lines' in big.truncated ? big.truncated.lines : undefined, MAX_DIFF_LINES + 11, '多出的一行是 @@ 头')
  const long = truncate(`@@ -0,0 +1 @@\n+${'x'.repeat(MAX_DIFF_CHARS * 2)}`)
  assert.equal(long.diff.length, MAX_DIFF_CHARS)
  assert.deepEqual(long.truncated, { lines: 2, chars: MAX_DIFF_CHARS * 2 + 15 })
  assert.deepEqual(truncate('@@ -1 +1 @@\n-a\n+b'), { diff: '@@ -1 +1 @@\n-a\n+b' })
  assert.equal(hunks('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'), '@@ -1 +1 @@\n-a\n+b')
})

test('列表固定用同一个提交：之后又有新提交，用旧 head 取到的还是旧的', () => {
  const { w, head } = setup()
  writeFileSync(join(w.worktree, 'later.txt'), 'later\n')
  git(w.worktree, 'add', '-A')
  git(w.worktree, 'commit', '-q', '-m', 'later')
  assert.ok(!committedChanges(w, head).files.some(f => f.path === 'later.txt'))
  assert.ok(committedChanges(w).files.some(f => f.path === 'later.txt'))
  assert.equal(onBranch(w, head), true, '旧 head 是当前 HEAD 的祖先')
  assert.equal(onBranch(w, 'HEAD'), false, '只接受完整的提交号')
  assert.equal(onBranch(w, '0'.repeat(40)), false)
})

test('没有提交改动时是空列表', () => {
  const dir = tmp()
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  assert.deepEqual(committedChanges(createWorktree(repo, dir, 't1')).files, [])
})

test('接口：任务详情带仓库、分支、worktree 和基线；列表和单个文件的 diff；不在分支上的提交 400；没有的任务和文件 404；worktree 没了给出原因', async () => {
  const { dir, repo, w, head } = setup()
  const store = new Store(join(dir, 'eos.db'))
  store.create({ id: 't1', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: w }, 1000)
  const supervisor = new Supervisor({ store, executor: new FakeExecutor(async () => '回复'), dataDir: dir, pollMs: 5 })
  const server = createWebServer({ store, supervisor, replay: { traceOf: async () => [] }, staticDir: join(dir, 'static'), credentials: new Credentials(':memory:', undefined) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const diffOf = (h: string, p: string) => fetch(`${base}/api/tasks/t1/changes/diff?${new URLSearchParams({ head: h, path: p })}`)
  try {
    const d = (await (await fetch(`${base}/api/tasks/t1`)).json()) as TaskDetail
    assert.deepEqual([d.repo, d.branch, d.worktree, d.baseSha], [w.repo, 'eos/t1', w.worktree, w.baseSha])
    const res = await fetch(`${base}/api/tasks/t1/changes`)
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()) as TaskChanges, committedChanges(w))
    const one = await diffOf(head, 'src/a.js')
    assert.equal(one.status, 200)
    assert.deepEqual((await one.json()) as FileDiff, fileDiff(w, head, 'src/a.js'))
    assert.equal((await diffOf(head, 'nope.txt')).status, 404)
    // 主仓库 main 上的提交不在任务分支上。
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'elsewhere')
    assert.equal((await diffOf(git(repo, 'rev-parse', 'main'), 'src/a.js')).status, 400)
    assert.equal((await diffOf('HEAD', 'src/a.js')).status, 400)
    assert.equal((await fetch(`${base}/api/tasks/nope/changes`)).status, 404)
    rmSync(w.worktree, { recursive: true, force: true })
    const gone = await fetch(`${base}/api/tasks/t1/changes`)
    assert.equal(gone.status, 500)
    assert.match(((await gone.json()) as { error: string }).error, /^读不到改动（worktree .+）：/)
  } finally {
    await new Promise(r => server.close(r))
    store.close()
  }
})

test('head 必须在基线和任务分支之间：基线之前的历史提交不行（读不到已删掉的文件）', () => {
  const dir = tmp()
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'secret-old.txt'), 'old secret\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'c0')
  const c0 = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'rm', '-q', 'secret-old.txt')
  git(repo, 'commit', '-q', '-m', 'base')
  const w = createWorktree(repo, dir, 't1')
  writeFileSync(join(w.worktree, 'a.txt'), 'a\n')
  git(w.worktree, 'add', '-A')
  git(w.worktree, 'commit', '-q', '-m', 'work')
  const head = git(w.worktree, 'rev-parse', 'HEAD')
  assert.equal(onBranch(w, c0), false, '基线之前的提交')
  assert.equal(onBranch(w, w.baseSha), true, '基线本身（还没有改动）')
  assert.equal(onBranch(w, head), true)
  // agent 在 worktree 里切到别处：列表和校验都以任务分支的 ref 为准。
  git(w.worktree, 'checkout', '-q', '--detach', c0)
  assert.deepEqual(
    committedChanges(w).files.map(f => f.path),
    ['a.txt'],
  )
  assert.equal(committedChanges(w).head, head)
  assert.equal(onBranch(w, c0), false)
})

test('改名并修改：列出改名和增删行数，diff 有内容', () => {
  const dir = tmp()
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'old.txt'), Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const w = createWorktree(repo, dir, 't1')
  git(w.worktree, 'mv', 'old.txt', 'new.txt')
  writeFileSync(join(w.worktree, 'new.txt'), Array.from({ length: 20 }, (_, i) => (i === 3 ? 'changed' : `line ${i}`)).join('\n') + '\n')
  git(w.worktree, 'add', '-A')
  git(w.worktree, 'commit', '-q', '-m', 'mv')
  const c = committedChanges(w)
  assert.deepEqual(c.files, [{ path: 'new.txt', from: 'old.txt', status: 'renamed', add: 1, del: 1, binary: false }])
  assert.match(fileDiff(w, c.head, 'new.txt')!.diff, /^@@ [\s\S]*-line 3\n\+changed/)
})

test('git 的输出超过上限时只读前面一部分，并注明', () => {
  const dir = tmp()
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  const w = createWorktree(repo, dir, 't1')
  writeFileSync(join(w.worktree, 'huge.txt'), `${'y'.repeat(1024)}\n`.repeat(Math.ceil(MAX_DIFF_BYTES / 1024) + 100))
  git(w.worktree, 'add', '-A')
  git(w.worktree, 'commit', '-q', '-m', 'huge')
  const d = fileDiff(w, committedChanges(w).head, 'huge.txt')!
  assert.deepEqual(d.truncated, { bytes: MAX_DIFF_BYTES })
  assert.ok(d.diff.startsWith('@@ '))
})

test('filesByCall：按平台提交说明里的调用 id 找出改到的文件；说明对不上的提交不算，同一调用的多次提交合在一起', () => {
  const dir = tmp()
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')
  const w = createWorktree(repo, dir, 't1')
  const commit = (files: Record<string, string>, message: string) => {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(w.worktree, f, '..'), { recursive: true })
      writeFileSync(join(w.worktree, f), c)
    }
    git(w.worktree, 'add', '-A')
    git(w.worktree, 'commit', '-q', '-m', message)
  }
  commit({ 'src/math.js': 'v1' }, 'eos: build produce (c2)')
  commit({ 'test/math.test.js': 't', 'b.txt': 'b' }, 'eos: build correct (c7)')
  commit({ 'src/math.js': 'v2' }, 'eos: build correct (c7)')
  commit({ 'x.txt': 'x' }, 'agent 自己的提交')
  commit({ '中文 名.txt': 'z' }, 'eos: build correct (c9)')
  assert.deepEqual(filesByCall(w), { c2: ['src/math.js'], c7: ['src/math.js', 'b.txt', 'test/math.test.js'], c9: ['中文 名.txt'] })
})
