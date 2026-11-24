import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { check, needsE2E, parseRules, sections } from './pr-checklist.ts'

const rules = parseRules(readFileSync(new URL('../e2e-paths.txt', import.meta.url), 'utf8'))

const proof = '## 能用证据证明的\n\n- 测试通过\n\n## 证明不了的和原因\n\n- 没有在别的内核上测\n'

test('仓库的规则文件：平台代码和构建、依赖、部署需要 E2E，文档、测试、验证脚本、CI 配置不需要，没列出的默认需要', () => {
  const need = ['src/engine/reduce.ts', 'src/workflow/skills/write-changes.md', 'src/workflow/templates/standard.yaml',
    'web/src/App.tsx', 'web/vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json',
    'vendor/dsh-sdk-client/client.ts', 'Dockerfile', 'compose.yaml', 'compose.override.yaml', '.dockerignore', 'newdir/x.ts', 'Makefile']
  const skip = ['docs/roadmap.md', 'docs/e2e/b1/run.log', 'tests/engine.test.ts', 'poc/run-all.sh', 'scripts/e2e.ts',
    '.github/workflows/ci.yml', '.claude/settings.json', 'README.md', 'CLAUDE.md', 'LICENSE', '.gitignore']
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
  assert.deepEqual(s.map((x) => x.title), ['A', 'B', 'B1', 'C'])
  assert.equal(s[0]!.content, '')
  assert.match(s[1]!.content, /### B1\n内容\n```\n# 不是标题\n```/)
  assert.equal(s[3]!.content, '')
})

test('缺少或空着「能用证据证明的」「证明不了的」时报错，不管改了什么', () => {
  assert.deepEqual(check({ body: proof, changed: ['docs/a.md'], rules }).errors, [])
  assert.equal(check({ body: '## 改动\n\n- x\n', changed: ['docs/a.md'], rules }).errors.length, 2)
  const empty = check({ body: '## 能证明的\n\n## 证明不了的\n- x\n', changed: ['docs/a.md'], rules })
  assert.deepEqual(empty.errors, ['「能证明的」一节是空的'])
})

test('没碰需要 E2E 的路径：不要求「端到端验证」一节', () => {
  const r = check({ body: proof, changed: ['docs/roadmap.md', 'tests/x.test.ts', '.github/workflows/ci.yml'], rules })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
})

test('碰了需要 E2E 的路径：缺「端到端验证」一节或一节是空的就失败', () => {
  assert.match(check({ body: proof, changed: ['src/a.ts'], rules }).errors.join(), /端到端验证/)
  assert.match(check({ body: `${proof}\n## 端到端验证\n\n`, changed: ['src/a.ts'], rules }).errors.join(), /端到端验证/)
  assert.match(check({ body: `${proof}\n## 端到端验证\n\n跑过了\n`, changed: ['src/a.ts'], rules }).errors.join(), /既没有/)
})

test('写了证据路径：文件或目录必须在这个 PR 里新增或修改过', () => {
  const body = `${proof}\n## 端到端验证\n\n见 \`docs/e2e/ci-3/run.log\`，截图在 docs/e2e/ci-3/shots/。\n`
  const ok = check({ body, changed: ['src/a.ts', 'docs/e2e/ci-3/run.log', 'docs/e2e/ci-3/shots/1.png'], rules })
  assert.deepEqual(ok.errors, [])
  const missing = check({ body, changed: ['src/a.ts', 'docs/e2e/ci-3/run.log'], rules })
  assert.deepEqual(missing.errors, ['「端到端验证」写的证据 docs/e2e/ci-3/shots/ 不在这个 PR 新增或修改的文件里'])
  // 前缀相同的另一个目录不算
  const prefix = check({ body: `${proof}\n## 端到端验证\n\ndocs/e2e/ci-3（日志）\n`, changed: ['src/a.ts', 'docs/e2e/ci-30/run.log'], rules })
  assert.equal(prefix.errors.length, 1)
})

test('写了「不需要」和理由：通过，但给出豁免提示；只写「不需要」没有理由不算', () => {
  const r = check({ body: `${proof}\n## 端到端验证\n\n不需要，理由是只改了注释。\n`, changed: ['src/a.ts'], rules })
  assert.deepEqual(r.errors, [])
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0]!, /只改了注释/)
  assert.equal(check({ body: `${proof}\n## 端到端验证\n\n不需要\n`, changed: ['src/a.ts'], rules }).errors.length, 1)
})
