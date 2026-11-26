import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changedPaths, isDocPath, isDocsOnly } from './docs-only.ts'

const ROOT = join(import.meta.dirname, '..', '..')

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
  // R、C 带两个路径，只在 --no-renames 下不会出现；万一出现了要报错，不能错位
  assert.throws(() => changedPaths('R100\0src/a.md\0docs/a.md\0'), /认不出的改动状态|格式不对/)
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

/** 列出目录下的文件（递归），跳过 node_modules */
const files = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e => (e.name === 'node_modules' ? [] : e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))

test('测试和 CI 脚本读到的文档都不能算「纯文档」（不然只改它的 PR 会跳过读它的测试）', () => {
  const sources = [...files('tests'), ...files('.github/scripts'), ...files('.github/lint')].filter(f => /\.(ts|mts|mjs|js)$/.test(f) && !f.endsWith('docs-only.test.ts'))
  const read: string[] = []
  for (const f of sources) {
    for (const line of readFileSync(join(ROOT, f), 'utf8').split('\n')) {
      if (!line.includes('readFileSync')) continue
      // join(ROOT, 'docs/…') 或 join(ROOT, 'X.md') 这种按仓库根目录读的路径
      for (const m of line.matchAll(/join\(\s*ROOT\s*,\s*'([^']+)'(?:\s*,\s*'([^']+)')*/g)) read.push(m.slice(1).filter(Boolean).join('/'))
    }
  }
  const docs = read.filter(p => p.startsWith('docs/') || (!p.includes('/') && p.endsWith('.md')))
  assert.ok(docs.includes('docs/deploy.md'), `扫描没找到 tests/image-probe.test.ts 读的 docs/deploy.md，扫描写法可能失效了：${read.join('、')}`)
  assert.deepEqual(docs.filter(isDocPath), [], '这些文档被测试或 CI 脚本读取，要在 docs-only.ts 的 isDocPath 里排除')
})

test('四个工作流里的 changes job 除了名字完全一样（改一处要改四处）', () => {
  const block = (f: string) => {
    const s = readFileSync(join(ROOT, '.github/workflows', f), 'utf8')
    const start = s.indexOf('\n  changes:\n')
    assert.ok(start >= 0, `${f} 里没有 changes job`)
    const end = s.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
    return s.slice(start + 1, start + 1 + end).replace(/name: changes-\w+/, 'name: changes-X')
  }
  const [first, ...rest] = ['ci.yml', 'image.yml', 'codeql.yml', 'dependency-review.yml'].map(block)
  assert.match(first!, /git show HEAD\^1:\.github\/scripts\/docs-only\.ts/)
  for (const b of rest) assert.equal(b, first)
})
