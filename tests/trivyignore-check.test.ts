import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, isDate } from '../.github/scripts/trivyignore-check.ts'

const ROOT = join(import.meta.dirname, '..')
const TODAY = '2026-11-26'
const entry = (o: { id?: string; purls?: string; statement?: string; expired?: string } = {}) =>
  [`  - id: ${o.id ?? 'CVE-2026-1'}`, `    purls: ${o.purls ?? "['pkg:npm/undici@8.11.2']"}`, `    statement: ${o.statement ?? '等上游升级'}`, `    expired_at: ${o.expired ?? '2026-12-25'}`].join(
    '\n',
  )
const doc = (...entries: string[]) => `# 注释\nvulnerabilities:\n${entries.join('\n')}\n`

test('仓库里的 .trivyignore.yaml 通过校验，4 条都锁到 undici@8.11.2', () => {
  const r = check(readFileSync(join(ROOT, '.trivyignore.yaml'), 'utf8'), TODAY)
  assert.deepEqual(r.errors, [])
  assert.equal(r.entries.length, 4)
  assert.ok(r.entries.every(e => e.purls.join() === 'pkg:npm/undici@8.11.2' && e.statement !== '' && isDate(e.expiredAt)))
})

test('四项写全的条目通过；多个 purls、双引号都认；行尾空白不影响', () => {
  const r = check(doc(entry(), entry({ id: 'GHSA-abcd-efgh-ijkl', purls: `["pkg:npm/a@1.0.0", 'pkg:golang/x/y@v0.1.0']` })) + '   \n', TODAY)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.entries[1]!.purls, ['pkg:npm/a@1.0.0', 'pkg:golang/x/y@v0.1.0'])
})

test('会悄悄放宽豁免的写法一律报错（独立审查实测 Trivy 会照单全收的几种）', () => {
  const cases: [string, string][] = [
    ['流式写法', 'vulnerabilities: [{id: CVE-2026-1}]\n'],
    ['- 后多一个空格、只写 id', 'vulnerabilities:\n  -  id: CVE-2026-1\n'],
    ['键名加引号', `vulnerabilities:\n  - "id": CVE-2026-1\n`],
    ['purls 为空（Trivy 当成不限包）', doc(entry({ purls: '[]' }))],
    ['purls 不带版本', doc(entry({ purls: "['pkg:npm/undici']" }))],
    ['多行 statement 里藏 expired_at', doc(`  - id: CVE-2026-1\n    purls: ['pkg:npm/a@1']\n    statement: |\n      expired_at: 2099-01-01`)],
    ['少 expired_at', doc(entry().split('\n').slice(0, 3).join('\n'))],
    [
      '少 purls',
      doc(
        entry()
          .split('\n')
          .filter(l => !l.includes('purls'))
          .join('\n'),
      ),
    ],
    ['字段写两次', doc(entry() + "\n    purls: ['pkg:npm/b@1']")],
    ['用 paths 代替 purls', doc(entry().replace(/purls: .*/, "paths: ['app/node_modules/undici/package.json']"))],
    ['字段顺序打乱（以 expired_at 开头）', 'vulnerabilities:\n  - expired_at: 2026-12-25\n    id: CVE-2026-1\n'],
    ['Tab 缩进', doc(entry().replace('    purls', '\tpurls'))],
  ]
  for (const [name, text] of cases) assert.notDeepEqual(check(text, TODAY).errors, [], name)
})

test('到期日：带引号、不存在的日期报错；已过期、7 天内到期给提示，天数按整天算', () => {
  assert.match(check(doc(entry({ expired: "'2026-12-25'" })), TODAY).errors.join(), /不加引号/)
  assert.match(check(doc(entry({ expired: '"2026-12-25"' })), TODAY).errors.join(), /不加引号/)
  for (const bad of ['2026-13-45', '2026-02-30', '2026/12/25']) assert.notDeepEqual(check(doc(entry({ expired: bad })), TODAY).errors, [], bad)
  const w = (d: string) => check(doc(entry({ expired: d })), TODAY).warnings.join()
  assert.match(w('2026-11-26'), /已经过期/)
  assert.match(w('2026-11-01'), /已经过期/)
  assert.match(w('2026-11-29'), /还剩 3 天/)
  assert.equal(w('2026-12-04'), '')
})

test('vulnerabilities 之前或之外的内容报错；没有这一节报错', () => {
  assert.notDeepEqual(check('misconfigurations:\n  - id: AVD-1\n', TODAY).errors, [])
  assert.notDeepEqual(check('# 只有注释\n', TODAY).errors, [])
  assert.notDeepEqual(check(doc(entry()) + 'vulnerabilities:\n', TODAY).errors, [])
})
