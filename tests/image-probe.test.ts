import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_USERS, parseChecks, parseUsers, usersScript } from '../.github/scripts/image-probe.ts'

const ROOT = join(import.meta.dirname, '..')
const doc = (table: string) => `# 部署\n\n## 执行器环境\n\n说明\n\n${table}\n\n后文，可以有 \`a\` 这样的反引号\n\n## 下一节\n\n| a | b |\n|---|---|\n| x | y |\n`

test('docs/deploy.md 的「执行器环境」表：每一行都有检查命令，表里的 \\| 还原成管道', () => {
  const rows = parseChecks(readFileSync(join(ROOT, 'docs/deploy.md'), 'utf8'))
  assert.deepEqual(
    rows.map(r => r.item),
    ['系统', 'Node、npm', 'pnpm、yarn', 'Python', '编译', '其他'],
  )
  assert.ok(rows.every(r => r.checks.length > 0))
  assert.ok(rows.flatMap(r => r.checks).includes("node --version | grep -q '^v24\\.'"))
  assert.ok(rows.flatMap(r => r.checks).includes('bwrap --version'))
})

test('解析不出来就报错，不静默跳过', () => {
  const ok = '| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | `true` |'
  assert.deepEqual(parseChecks(doc(ok)), [{ item: '系统', checks: ['true'] }])
  assert.throws(() => parseChecks('# 没有这一节\n'), /找不到「## 执行器环境」/)
  assert.throws(() => parseChecks(doc('没有表')), /找不到表/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 |\n|---|---|\n| 系统 | x |')), /没有「检查」一列/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | 没写命令 |')), /没有写检查命令/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | `true` |')), /列数不对/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n| 系统 | x | `true` |')), /格式不对/)
  // 第一轮独立审查实测：下面这几种行在 GFM 里照样是表格的一行，原来会被悄悄跳过、或者检查被截断
  const head = '| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | `true` |\n'
  assert.throws(() => parseChecks(doc(`${head}  | b | x | \`false\` |`)), /以 \| 开头/)
  assert.throws(() => parseChecks(doc(`${head}b | x | \`false\` |`)), /以 \| 开头/)
  assert.throws(() => parseChecks(doc(`${head}\n| b | x | \`false\` |`)), /表后面还有表格行/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | ` ` |')), /空的检查命令/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | ``echo `x` `` |')), /双反引号/)
})

test('探针期望的用户和 Dockerfile 的 useradd 对得上（改 Dockerfile 的用户时两边一起改，由审查把关）', () => {
  const parsed = parseUsers(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))
  // Dockerfile 里的 --groups 是附加组，主组是和用户同名的组
  assert.deepEqual(
    parsed.map(u => ({ ...u, groups: [u.name, ...u.groups].sort() })),
    EXPECTED_USERS.map(u => ({ ...u, groups: [...u.groups].sort() })),
  )
})

test('useradd 认不出来就报错，不会悄悄少查一个用户；选项顺序不影响', () => {
  assert.throws(() => parseUsers('FROM x\n'), /找不到 useradd/)
  assert.throws(() => parseUsers('RUN useradd --uid 1 --groups a x \\\n && useradd --create-home y\n'), /认不出来/)
  assert.deepEqual(parseUsers('RUN useradd --groups a,b --uid 7 --create-home u \\\n && true\n'), [{ name: 'u', uid: 7, groups: ['a', 'b'] }])
})

test('核对脚本：每个用户的 uid、完整的组集合，以及 /data 属主都有一条', () => {
  const script = usersScript(EXPECTED_USERS)
  for (const u of EXPECTED_USERS) {
    assert.match(script, new RegExp(`id -u ${u.name}\\)" = ${u.uid}`))
    assert.ok(script.includes(`test "$g" = "${[...u.groups].sort().join(' ')}"`), u.name)
  }
  assert.match(script, /stat -c %U:%G \/data\)" = eos:eos/)
})
