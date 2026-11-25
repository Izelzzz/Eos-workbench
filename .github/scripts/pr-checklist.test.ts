import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { check, e2eNeed, parseNameStatusZ, parseRules, sections, stripHtmlComments, type Change } from './pr-checklist.ts'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rules = parseRules(readFileSync(new URL('../e2e-paths.txt', import.meta.url), 'utf8'))

/** 新增或修改的文件 */
const ch = (...paths: string[]): Change[] => paths.map(path => ({ path, deleted: false }))

const proof = '## 能用证据证明的\n\n- 测试通过\n\n## 证明不了的和原因\n\n- 没有在别的内核上测\n'

test('仓库的规则文件：影响模型行为的文件、其余平台代码、构建、依赖、部署要真实模型；确定性 E2E 跑到的代码归「确定性」；文档、测试、脚本、CI 配置不需要；没列出的默认要真实模型', () => {
  const need = [
    'src/engine/prompts.ts',
    'src/workflow/agents/developer.yaml',
    'src/workflow/docs/研发约定.md',
    'src/improve/generate.ts',
    'src/forge/github.ts',
    'src/credentials/store.ts',
    'src/web/server.ts',
    'src/conventions/conventions.ts',
    'src/runner/git.ts',
    'src/runner/runner.ts',
    'src/runner/supervisor.ts',
    'src/runner/check-user.ts',
    'src/runner/mirror.ts',
    'src/runner/doctor.ts',
    'src/engine/checks.ts',
    'src/engine/verdict.ts',
    'src/engine/evidence.ts',
    'src/trace/build.ts',
    'src/executor/dsh.ts',
    'src/workflow/new-prompts.md',
    'src/engine/new-module.ts',
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
  const ci = ['src/cli.ts', 'src/engine/machine.ts', 'src/store/store.ts', 'src/runner/procs.ts', 'src/workflow/parse.ts', 'src/workflow/templates.ts', 'src/executor/types.ts']
  for (const p of need) assert.equal(e2eNeed(p, rules), 'real', p)
  for (const p of ci) assert.equal(e2eNeed(p, rules), 'ci', p)
  for (const p of skip) assert.equal(e2eNeed(p, rules), 'none', p)
})

test('规则按顺序匹配，第一条算数；看不懂的行报出行号', () => {
  const r = parseRules('# 注释\n\n需要 a/**\n不需要 a/b/**\n确定性 c/**\n')
  assert.equal(e2eNeed('a/b/c', r), 'real')
  assert.equal(e2eNeed('c/d', r), 'ci')
  assert.equal(e2eNeed('z', r), 'real')
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

test('只碰到「确定性」的路径：不要求「端到端验证」一节，提示由 e2e-fake-model 验证；同时碰到要真实模型的路径时照旧要求', () => {
  const only = check({ body: proof, changed: ch('src/engine/machine.ts', 'tests/engine.test.ts'), rules })
  assert.deepEqual(only.errors, [])
  assert.match(only.notes.join(), /e2e-fake-model/)
  const mixed = check({ body: proof, changed: ch('src/engine/machine.ts', 'src/engine/prompts.ts'), rules })
  assert.match(mixed.errors.join(), /端到端验证/)
  assert.match(mixed.notes.join(), /src\/engine\/prompts\.ts/)
  assert.doesNotMatch(mixed.notes.join(), /runner\.ts/)
})
