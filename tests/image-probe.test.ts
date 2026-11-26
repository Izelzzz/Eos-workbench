import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseChecks, parseUsers, usersScript } from '../.github/scripts/image-probe.ts'

const ROOT = join(import.meta.dirname, '..')
const doc = (table: string) => `# 部署\n\n## 执行器环境\n\n说明\n\n${table}\n\n后文\n\n## 下一节\n\n| a | b |\n|---|---|\n| x | y |\n`

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
})

test('Dockerfile 的三个用户：uid 和组都解析出来；核对脚本里每个用户、每个组和 /data 属主都有一条', () => {
  const users = parseUsers(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))
  assert.deepEqual(users, [
    { name: 'eos', uid: 10001, groups: ['eos-work', 'eos-dsh'] },
    { name: 'eos-check', uid: 10002, groups: ['eos-work'] },
    { name: 'eos-agent', uid: 10003, groups: ['eos-work', 'eos-dsh'] },
  ])
  const script = usersScript(users)
  for (const u of users) {
    assert.match(script, new RegExp(`id -u ${u.name}\\)" = ${u.uid}`))
    for (const g of u.groups) assert.match(script, new RegExp(`id -nG ${u.name} .* grep -qx ${g}`))
  }
  assert.match(script, /stat -c %U:%G \/data\)" = eos:eos/)
  assert.throws(() => parseUsers('FROM x\n'), /找不到 useradd/)
})
