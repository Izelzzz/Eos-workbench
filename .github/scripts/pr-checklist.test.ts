import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { check, gitRepo, needsE2E, parseNameStatusZ, parseRules, sections, stripHtmlComments, type Change, type Repo } from './pr-checklist.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rules = parseRules(readFileSync(new URL('../e2e-paths.txt', import.meta.url), 'utf8'))

/** 新增或修改的文件 */
const ch = (...paths: string[]): Change[] => paths.map(path => ({ path, deleted: false }))

const proof = '## 能用证据证明的\n\n- 测试通过\n\n## 证明不了的和原因\n\n- 没有在别的内核上测\n'

test('仓库的规则文件：平台代码和构建、依赖、部署需要 E2E，文档、测试、验证脚本、CI 配置不需要，没列出的默认需要', () => {
  const need = [
    'src/engine/reduce.ts',
    'src/workflow/skills/write-changes.md',
    'src/workflow/templates/standard.yaml',
    'web/src/App.tsx',
    'web/vite.config.ts',
    'tsconfig.json',
    'package.json',
    'package-lock.json',
    'vendor/dsh-sdk-client/client.ts',
    'Dockerfile',
    'compose.yaml',
    'compose.override.yaml',
    '.dockerignore',
    'newdir/x.ts',
    'Makefile',
  ]
  const skip = [
    'docs/roadmap.md',
    'docs/e2e/b1/run.log',
    'tests/engine.test.ts',
    'poc/run-all.sh',
    'scripts/e2e.ts',
    '.github/workflows/ci.yml',
    '.gitleaksignore',
    '.gitleaks.toml',
    '.claude/settings.json',
    'README.md',
    'CLAUDE.md',
    'LICENSE',
    '.gitignore',
  ]
  for (const p of need) assert.equal(needsE2E(p, rules), true, p)
  for (const p of skip) assert.equal(needsE2E(p, rules), false, p)
})

test('规则按顺序匹配，第一条算数；看不懂的行报出行号', () => {
  const r = parseRules('# 注释\n\n需要 a/**\n不需要 a/b/**\n')
  assert.equal(needsE2E('a/b/c', r), true)
  assert.throws(() => parseRules('需要\n'), /第 1 行/)
  assert.throws(() => parseRules('也许 x\n'), /第 1 行/)
})

test('切分描述：低一级的标题算在外层节里，代码块里的 # 不是标题，HTML 注释不算内容', () => {
  const s = sections('## A\n<!-- 待填 -->\n## B\n### B1\n内容\n```\n# 不是标题\n```\n## C\n')
  assert.deepEqual(
    s.map(x => x.title),
    ['A', 'B', 'B1', 'C'],
  )
  assert.equal(s[0]!.content, '')
  assert.match(s[1]!.content, /### B1\n内容\n```\n# 不是标题\n```/)
  assert.equal(s[3]!.content, '')
})

test('缺少或空着「能用证据证明的」「证明不了的」时报错，不管改了什么', () => {
  assert.deepEqual(check({ body: proof, changed: ch('docs/a.md'), rules }).errors, [])
  assert.equal(check({ body: '## 改动\n\n- x\n', changed: ch('docs/a.md'), rules }).errors.length, 2)
  const empty = check({ body: '## 能证明的\n\n## 证明不了的\n- x\n', changed: ch('docs/a.md'), rules })
  assert.deepEqual(empty.errors, ['「能证明的」一节是空的'])
})

test('没碰需要 E2E 的路径：不要求「端到端验证」一节', () => {
  const r = check({ body: proof, changed: ch('docs/roadmap.md', 'tests/x.test.ts', 'poc/run-all.sh'), rules })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
})

test('碰了需要 E2E 的路径：缺「端到端验证」一节或一节是空的就失败', () => {
  assert.match(check({ body: proof, changed: ch('src/a.ts'), rules }).errors.join(), /端到端验证/)
  assert.match(check({ body: `${proof}\n## 端到端验证\n\n`, changed: ch('src/a.ts'), rules }).errors.join(), /端到端验证/)
  assert.match(check({ body: `${proof}\n## 端到端验证\n\n跑过了\n`, changed: ch('src/a.ts'), rules }).errors.join(), /既没有/)
})

test('写了证据路径：文件或目录必须在这个 PR 里新增或修改过', () => {
  const body = `${proof}\n## 端到端验证\n\n见 \`docs/e2e/ci-3/run.log\`，截图在 docs/e2e/ci-3/shots/。\n`
  const ok = check({ body, changed: ch('src/a.ts', 'docs/e2e/ci-3/run.log', 'docs/e2e/ci-3/shots/1.png'), rules })
  assert.deepEqual(ok.errors, [])
  const missing = check({ body, changed: ch('src/a.ts', 'docs/e2e/ci-3/run.log'), rules })
  assert.deepEqual(missing.errors, ['「端到端验证」写的证据 docs/e2e/ci-3/shots/ 不在这个 PR 新增或修改的文件里'])
  // 前缀相同的另一个目录不算
  const prefix = check({ body: `${proof}\n## 端到端验证\n\ndocs/e2e/ci-3（日志）\n`, changed: ch('src/a.ts', 'docs/e2e/ci-30/run.log'), rules })
  assert.equal(prefix.errors.length, 1)
})

test('写了「不需要」和理由：通过，但给出豁免提示；只写「不需要」没有理由不算', () => {
  const r = check({ body: `${proof}\n## 端到端验证\n\n不需要，理由是只改了注释。\n`, changed: ch('src/a.ts'), rules })
  assert.deepEqual(r.errors, [])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0]!, /只改了注释/)
  assert.equal(check({ body: `${proof}\n## 端到端验证\n\n不需要\n`, changed: ch('src/a.ts'), rules }).errors.length, 1)
})

test('改了检查规则或允许清单：给出提示，提示里列出是哪些文件；只改别的不提示', () => {
  const r = check({ body: proof, changed: ch('.gitleaksignore', '.github/workflows/ci.yml', 'docs/a.md'), rules })
  assert.deepEqual(r.errors, [])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0]!, /\.gitleaksignore、\.github\/workflows\/ci\.yml/)
  for (const p of ['.gitleaks.toml', '.github/e2e-paths.txt', '.github/scripts/pr-checklist.ts', '.github/lint/eslint.config.mjs', '.github/codeql/codeql-config.yml']) {
    assert.equal(check({ body: proof, changed: ch(p), rules }).warnings.length, 1, p)
  }
  assert.deepEqual(check({ body: proof, changed: ch('docs/a.md', '.github/README.md'), rules }).warnings, [])
})

test('删掉的文件算改动（要不要 E2E），但不能当证据', () => {
  const body = `${proof}\n## 端到端验证\n\n见 docs/e2e/b1/run.log\n`
  const r = check({ body, changed: [...ch('src/a.ts'), { path: 'docs/e2e/b1/run.log', deleted: true }], rules })
  assert.deepEqual(r.errors, ['「端到端验证」写的证据 docs/e2e/b1/run.log 不在这个 PR 新增或修改的文件里'])
  const onlyDeleted = check({ body: proof, changed: [{ path: 'src/old.ts', deleted: true }], rules })
  assert.match(onlyDeleted.errors.join(), /端到端验证/)
})

test('豁免要以「不需要」开头；理由可以换行写，提示里带上完整理由', () => {
  const casual = check({ body: `${proof}\n## 端到端验证\n\n本地跑过了，截图不需要附上\n`, changed: ch('src/a.ts'), rules })
  assert.match(casual.errors.join(), /既没有/)
  const multi = check({ body: `${proof}\n## 端到端验证\n\n不需要\n理由是只改了类型标注\n`, changed: ch('src/a.ts'), rules })
  assert.deepEqual(multi.errors, [])
  assert.match(multi.warnings.join(), /只改了类型标注/)
})

test('证据路径里的 * 不当通配，按它前面的目录匹配', () => {
  const r = check({ body: `${proof}\n## 端到端验证\n\n截图在 docs/e2e/ci-3/shots/*.png\n`, changed: ch('src/a.ts', 'docs/e2e/ci-3/shots/1.png'), rules })
  assert.deepEqual(r.errors, [])
})

test('「不能证明的」不算「能证明的」；标题要以这几个词开头', () => {
  const r = check({ body: '## 不能证明的\n- x\n## 证明不了的\n- y\n', changed: ch('docs/a.md'), rules })
  assert.deepEqual(r.errors, ['描述里缺少「能用证据证明的」一节（CLAUDE.md 自检第 7 条）'])
})

test('代码块只由开始时的那种标记结束：``` 块里的 ~~~ 不结束它', () => {
  const s = sections('## A\n```\n~~~\n# 还在代码块里\n```\n## B\nx\n')
  assert.deepEqual(
    s.map(x => x.title),
    ['A', 'B'],
  )
})

test('真实 git 输出：中文文件名不被转义，删除记成 deleted；中文证据路径能对上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-checklist-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q')
    mkdirSync(join(dir, 'docs/e2e/b1'), { recursive: true })
    writeFileSync(join(dir, 'docs/e2e/b1/旧.log'), 'x')
    git('add', '.')
    git('commit', '-qm', 'a')
    writeFileSync(join(dir, 'docs/e2e/b1/截图.png'), 'x')
    rmSync(join(dir, 'docs/e2e/b1/旧.log'))
    git('add', '-A')
    git('commit', '-qm', 'b')
    const changed = parseNameStatusZ(git('diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD'))
    assert.deepEqual(changed, [
      { path: 'docs/e2e/b1/截图.png', deleted: false },
      { path: 'docs/e2e/b1/旧.log', deleted: true },
    ])
    const r = check({ body: `${proof}\n## 端到端验证\n\n见 docs/e2e/b1/截图.png 。\n`, changed: [...ch('src/a.ts'), ...changed], rules })
    assert.deepEqual(r.errors, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('表格里紧挨 | 的证据路径能取出来', () => {
  const r = check({ body: `${proof}\n## 端到端验证\n\n| 证据 |docs/e2e/b1/run.log|\n`, changed: ch('src/a.ts', 'docs/e2e/b1/run.log'), rules })
  assert.deepEqual(r.errors, [])
})

test('HTML 注释和 GitHub 渲染一致：嵌套、没闭合、空注释、代码里的 <!--', () => {
  assert.equal(stripHtmlComments('a<!-- x -->b<!-- y -->c'), 'abc')
  // 嵌套的只到第一个 -->，剩下的 --> 在 GitHub 上看得见
  assert.equal(stripHtmlComments('<!--<!-- x -->-->'), '-->')
  assert.equal(stripHtmlComments('<!-<!---->-'), '<!--')
  // <!--> 和 <!---> 是空注释，后面照常显示
  assert.equal(stripHtmlComments('- a <!--> b\n- c'), '- a  b\n- c')
  assert.equal(stripHtmlComments('a<!--->b'), 'ab')
  // 跨行注释
  assert.equal(stripHtmlComments('a<!-- x\ny -->b\nc'), 'a\nb\nc')
  // 没闭合：行首的藏到末尾，行中间的是普通文字
  assert.equal(stripHtmlComments('a\n<!-- 待填\n## 标题'), 'a\n')
  assert.equal(stripHtmlComments('见 a<!-- 待填\nb'), '见 a<!-- 待填\nb')
  // 代码块和行内代码里的不算
  assert.equal(stripHtmlComments('```html\n<!-- 示例\n```\nb'), '```html\n<!-- 示例\n```\nb')
  assert.equal(stripHtmlComments('用 `<!--` 开头\nb'), '用 `<!--` 开头\nb')
  // 去掉的注释里的反引号不影响后面：行首的是 HTML 块，块里不认行内代码；行中间的只数保留下来的反引号
  assert.equal(stripHtmlComments('<!-- ` --> <!-- 待填 -->'), ' ')
  assert.equal(stripHtmlComments('x<!-- ` -->y <!-- z -->'), 'xy ')
  // 行内注释不能跨过空行
  assert.equal(stripHtmlComments('见 a <!-- 这里\n\n## 标题\n- A --> B'), '见 a <!-- 这里\n\n## 标题\n- A --> B')
  // HTML 块可以跨过空行
  assert.equal(stripHtmlComments('<!-- a\n\nb -->c\nd'), '\nc\nd')
})

test('只有没闭合注释的一节算空的；代码块里写 <!-- 不影响后面的节', () => {
  const hidden = check({ body: '## 能用证据证明的\n\n<!-- 待填\n## 证明不了的\n- x\n', changed: ch('docs/a.md'), rules })
  assert.ok(
    hidden.errors.some(e => e.includes('能用证据证明的')),
    hidden.errors.join(),
  )
  const fenced = check({ body: '## 能用证据证明的\n\n```html\n<!-- 示例\n```\n- ok\n## 证明不了的\n- x\n', changed: ch('docs/a.md'), rules })
  assert.deepEqual(fenced.errors, [])
  const tick = check({ body: '## 能用证据证明的\n\n<!-- ` --> <!-- 待填 -->\n## 证明不了的\n- x\n', changed: ch('docs/a.md'), rules })
  assert.deepEqual(tick.errors, ['「能用证据证明的」一节是空的'])
  const para = check({ body: '## 能用证据证明的\n\n- 见 a <!-- 这里\n\n## 证明不了的\n- A --> B\n', changed: ch('docs/a.md'), rules })
  assert.deepEqual(para.errors, [])
})

// ── 证据对得上最终代码 ──────────────────────────────────────────────────
const C = 'a'.repeat(40)
/** 桩：changedAfter 里的文件在 C 之后又改过 */
const stub = (o: { report?: unknown; inHistory?: boolean; changedAfter?: string[] }): Repo => ({
  report: () => (o.report === undefined ? { commit: C, uncommitted: [] } : (o.report as never)),
  inHistory: () => o.inHistory ?? true,
  same: (_c, p) => !(o.changedAfter ?? []).includes(p),
})
const withEvidence = (extra = '') => `${proof}\n## 端到端验证\n\n见 docs/e2e/x/\n${extra}`
const changedWith = (...src: string[]) => ch(...src, 'docs/e2e/x/report.json', 'docs/e2e/x/run.log')

test('证据对得上：报告的提交在历史里，PR 改过的「需要」文件此后没变 → 通过', () => {
  const r = check({ body: withEvidence(), changed: changedWith('src/engine/prompts.ts'), rules, repo: stub({}) })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.match(r.notes.join(), /对得上最终代码/)
})

test('跑完 E2E 又改了「需要」的文件 → 报错；写了「证据之后的改动」一节 → 改成要人确认的提示', () => {
  const stale = stub({ changedAfter: ['src/engine/prompts.ts'] })
  const r = check({ body: withEvidence(), changed: changedWith('src/engine/prompts.ts', 'src/runner/runner.ts'), rules, repo: stale })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0]!, /src\/engine\/prompts\.ts/)
  assert.doesNotMatch(r.errors[0]!, /runner\.ts/)
  const ok = check({ body: withEvidence('\n## 证据之后的改动\n\n只改了一行注释\n'), changed: changedWith('src/engine/prompts.ts'), rules, repo: stale })
  assert.deepEqual(ok.errors, [])
  assert.match(ok.warnings.join(), /只改了一行注释/)
  // 这一节是空的不算
  assert.equal(check({ body: withEvidence('\n## 证据之后的改动\n\n'), changed: changedWith('src/engine/prompts.ts'), rules, repo: stale }).errors.length, 1)
})

test('之后只改了测试或文档（不需要 E2E 的文件）不报错', () => {
  const r = check({ body: withEvidence(), changed: changedWith('src/engine/prompts.ts', 'tests/x.test.ts'), rules, repo: stub({ changedAfter: ['tests/x.test.ts', 'docs/a.md'] }) })
  assert.deepEqual(r.errors, [])
})

test('报告的提交不在 PR 历史里、跑的时候有没提交的改动、报告坏了 → 报错；报告没记提交、证据里没报告 → 提示', () => {
  const notInHistory = check({ body: withEvidence(), changed: changedWith('src/a.ts'), rules, repo: stub({ inHistory: false }) })
  assert.match(notInHistory.errors.join(), /不在这个 PR 的历史里/)
  const dirty = check({ body: withEvidence(), changed: changedWith('src/a.ts'), rules, repo: stub({ report: { commit: C, uncommitted: ['src/a.ts', 'notes.txt'] } }) })
  assert.match(dirty.errors.join(), /没提交的改动：src\/a\.ts/)
  assert.doesNotMatch(dirty.errors.join(), /notes\.txt/)
  const broken: Repo = { ...stub({}), report: () => undefined }
  assert.match(check({ body: withEvidence(), changed: changedWith('src/a.ts'), rules, repo: broken }).errors.join(), /不是合法的 JSON/)
  const noCommit = check({ body: withEvidence(), changed: changedWith('src/a.ts'), rules, repo: stub({ report: { uncommitted: [] } }) })
  assert.deepEqual(noCommit.errors, [])
  assert.match(noCommit.warnings.join(), /没有记下跑的是哪个提交/)
  const noReport = check({ body: withEvidence(), changed: ch('src/a.ts', 'docs/e2e/x/run.log'), rules, repo: stub({}) })
  assert.deepEqual(noReport.errors, [])
  assert.match(noReport.warnings.join(), /没有 E2E 报告/)
})

test('真实 git：在 GitHub 那样的合并提交上核对证据（证据之后改提示词变红、只改测试和只合进 main 不变红、证据提交不在历史里变红）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-evidence-'))
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  const write = (p: string, s: string) => {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), s)
  }
  const commit = (m: string) => {
    git('add', '-A')
    git('commit', '-qm', m)
    return git('rev-parse', 'HEAD')
  }
  /** 在 base 上模拟 GitHub 的合并提交（HEAD^1 = base，HEAD^2 = PR 最新提交），返回改动和核对结果 */
  const verify = (base: string, head: string, body = withEvidence()) => {
    git('checkout', '-q', '--detach', base)
    git('merge', '-q', '--no-ff', '--no-edit', head)
    const changed = parseNameStatusZ(git('diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD') + '\0')
    const r = check({ body, changed, rules, repo: gitRepo(dir) })
    git('checkout', '-q', head)
    return r
  }
  try {
    git('init', '-q', '-b', 'main')
    write('src/engine/prompts.ts', 'v1\n')
    write('src/other.ts', 'o1\n')
    const base = commit('base')
    git('checkout', '-q', '-b', 'pr')
    write('src/engine/prompts.ts', 'v2\n')
    const tested = commit('改提示词')
    write('docs/e2e/x/report.json', JSON.stringify({ commit: tested, uncommitted: [] }))
    write('docs/e2e/x/run.log', 'ok')
    const withProof = commit('证据')
    assert.deepEqual(verify(base, withProof).errors, [], 'E2E 之后只加了证据')

    write('tests/x.test.ts', 't')
    const onlyTests = commit('只改测试')
    assert.deepEqual(verify(base, onlyTests).errors, [], '之后只改测试')

    // main 前进（改了 PR 没碰的文件），PR 合进 main
    git('checkout', '-q', 'main')
    write('src/other.ts', 'o2\n')
    const main2 = commit('main 前进')
    git('checkout', '-q', 'pr')
    git('merge', '-q', '--no-edit', 'main')
    const merged = git('rev-parse', 'HEAD')
    assert.deepEqual(verify(main2, merged).errors, [], '只合进 main')

    write('src/engine/prompts.ts', 'v3\n')
    const changedAgain = commit('证据之后又改提示词')
    assert.match(verify(main2, changedAgain).errors.join(), /src\/engine\/prompts\.ts/, '证据之后改提示词')

    // 证据记的提交不在 PR 的历史里
    write('docs/e2e/x/report.json', JSON.stringify({ commit: 'b'.repeat(40), uncommitted: [] }))
    const foreign = commit('别处的证据')
    assert.match(verify(main2, foreign).errors.join(), /不在这个 PR 的历史里/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
