import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedPaths, isDocPath, isDocsOnly } from '../.github/scripts/docs-only.ts'

const z = (...pairs: [string, string][]) => pairs.map(([s, p]) => `${s}\0${p}\0`).join('')

test('docs/ 下和根目录的 *.md 算文档；docs/deploy.md、src/ 下的 md 和别的文件都不算', () => {
  for (const p of ['docs/roadmap.md', 'docs/e2e/x/run.log', 'docs/adr/a.png', 'README.md', 'CLAUDE.md']) assert.equal(isDocPath(p), true, p)
  for (const p of ['docs/deploy.md', 'src/engine/prompts/plan.md', 'src/skills/x/SKILL.md', 'web/README.md', '.github/README.md', 'README.txt', 'package.json', 'docs', 'Dockerfile']) {
    assert.equal(isDocPath(p), false, p)
  }
})

test('纯文档才跳过；混了一个 src 文件、src 下的 md、docs/deploy.md、没有改动，都跑全套', () => {
  assert.equal(isDocsOnly(['docs/roadmap.md', 'README.md']), true)
  assert.equal(isDocsOnly(['docs/roadmap.md', 'src/cli.ts']), false)
  assert.equal(isDocsOnly(['docs/roadmap.md', 'src/engine/prompts/plan.md']), false)
  assert.equal(isDocsOnly(['docs/deploy.md']), false)
  assert.equal(isDocsOnly([]), false)
})

test('解析 name-status：删除算路径；认不出的格式报错，不当成纯文档', () => {
  assert.deepEqual(changedPaths(z(['M', 'docs/a.md'], ['D', 'README.md'], ['A', 'docs/b.md'])), ['docs/a.md', 'README.md', 'docs/b.md'])
  assert.deepEqual(changedPaths(''), [])
  assert.throws(() => changedPaths('M\0docs/a.md\0D\0'), /格式不对/)
  assert.throws(() => changedPaths('docs/a.md\0M\0'), /认不出的改动状态/)
})

test('真实 git：在合并提交上看 HEAD^1..HEAD，重命名拆成删除旧路径和新增新路径，两边都要是文档', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-only-'))
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' })
  const write = (p: string, s: string) => {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), s)
  }
  /** 在 main 上合并 head（像 GitHub 的合并提交），返回判断结果 */
  const verdict = (head: string) => {
    git('checkout', '-q', '--detach', 'main')
    git('merge', '-q', '--no-ff', '--no-edit', head)
    const r = isDocsOnly(changedPaths(git('diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD')))
    git('checkout', '-q', 'main')
    return r
  }
  const branch = (name: string, change: () => void) => {
    git('checkout', '-q', '-b', name, 'main')
    change()
    git('add', '-A')
    git('commit', '-qm', name)
    git('checkout', '-q', 'main')
    return name
  }
  try {
    git('init', '-q', '-b', 'main')
    write('docs/a.md', 'a\n')
    write('src/prompt.md', 'p\n')
    write('src/cli.ts', 'x\n')
    git('add', '-A')
    git('commit', '-qm', 'base')
    assert.equal(verdict(branch('docs', () => write('docs/a.md', 'b\n'))), true, '只改文档')
    assert.equal(verdict(branch('mixed', () => (write('docs/a.md', 'c\n'), write('src/cli.ts', 'y\n')))), false, '混了 src')
    assert.equal(verdict(branch('del', () => rmSync(join(dir, 'docs/a.md')))), true, '删除文档')
    assert.equal(verdict(branch('mv-in', () => git('mv', 'docs/a.md', 'docs/b.md'))), true, '文档之间重命名')
    assert.equal(verdict(branch('mv-out', () => git('mv', 'src/prompt.md', 'docs/prompt.md'))), false, '从 src 挪进 docs')
    assert.equal(verdict(branch('mv-src', () => git('mv', 'docs/a.md', 'src/a.md'))), false, '从 docs 挪进 src')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
