import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_USERS, parseChecks, parseUsers, usersScript } from '../.github/scripts/image-probe.ts'

const ROOT = join(import.meta.dirname, '..')
const doc = (table: string) =>
  `# 部署\n\n## 执行器环境\n\n### 镜像里有什么\n\n说明，可以有 \`a\` 这样的反引号\n\n${table}\n\n后文\n\n### 依赖和别的工具\n\n- 列表、\`\`\`代码块\`\`\`、| 都可以\n\n## 下一节\n\n| a | b |\n|---|---|\n| x | y |\n`

test('docs/deploy.md 的「镜像里有什么」表：每一行都有检查命令，表里的 \\| 还原成管道', () => {
  const rows = parseChecks(readFileSync(join(ROOT, 'docs/deploy.md'), 'utf8'))
  assert.deepEqual(
    rows.map(r => r.item),
    ['系统', 'Node、npm', 'pnpm、yarn', 'Python', '编译', '其他'],
  )
  assert.ok(rows.every(r => r.checks.length > 0))
  assert.ok(rows.flatMap(r => r.checks).includes("node --version | grep -q '^v24\\.'"))
  assert.ok(rows.flatMap(r => r.checks).includes('bwrap --version'))
})

const head = '| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | `true` |'

test('解析不出来就报错，不静默跳过', () => {
  assert.deepEqual(parseChecks(doc(head)), [{ item: '系统', checks: ['true'] }])
  assert.throws(() => parseChecks('# 没有这一节\n'), /「## 执行器环境」要正好出现一次，现在是 0 次/)
  assert.throws(() => parseChecks('## 执行器环境\n\n| a |\n\n## 别的\n\n### 镜像里有什么\n'), /找不到「### 镜像里有什么」/)
  assert.throws(() => parseChecks(doc('没有表')), /找不到表/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 |\n|---|---|\n| 系统 | x |')), /没有「检查」一列/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | 没写命令 |')), /没有写检查命令/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | `true` |')), /列数不对/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n| 系统 | x | `true` |')), /格式不对/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | ` ` |')), /空的检查命令/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | ``echo `x` `` |')), /双反引号/)
})

test('这一小节里只能有这张表和不带格式的说明：在页面上显示成表格、实际不检查的写法一律报错', () => {
  // 表里：缩进的行、不以 | 开头的行（GFM 里照样是表格的一行）
  assert.throws(() => parseChecks(doc(`${head}\n  | b | x | \`false\` |`)), /以 \| 开头/)
  assert.throws(() => parseChecks(doc(`${head}\nb | x | \`false\` |`)), /以 \| 开头/)
  assert.throws(() => parseChecks(doc(`${head}\n\`false\``)), /以 \| 开头/)
  // 表外：几轮独立审查举的写法——空行后的第二张表、表前不写前导 | 的表、引用块里的表、HTML 表格、代码块、缩进、列表
  const outside = [
    '| b | x | `false` |',
    'a | b | c\n--|--|--\nx | y | `false`',
    '> | 内容 | 版本 | 检查 |\n> |---|---|---|\n> | b | y | `false` |',
    '<table><tr><td>`false`</td></tr></table>',
    '```\n~~~\n```',
    '    | grep x',
    '- 列表',
    '1. 列表',
    '#### 小标题',
    '说明 <table><tr><td>`false`</td></tr></table>',
    '说明 <pre>false</pre>',
  ]
  for (const extra of outside) {
    assert.throws(() => parseChecks(doc(`${head}\n\n${extra}`)), /表外只能是不带格式的说明文字/, `表后：${extra}`)
    assert.throws(() => parseChecks(doc(`${extra}\n\n${head}`)), /表外只能是不带格式的说明文字|以 \| 开头/, `表前：${extra}`)
  }
  // 第四轮复审：在注释或代码块里放一个假的同名小节、同一节里写两遍小节标题、分隔行列数不对、表格里的 HTML
  assert.throws(() => parseChecks(`<!--\n## 执行器环境\n\n### 镜像里有什么\n\n| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | \`true\` |\n-->\n${doc(head)}`), /正好出现一次，现在是 2 次/)
  assert.throws(() => parseChecks(doc(head).replace('### 依赖和别的工具', `### 镜像里有什么\n\n${head.replace('`true`', '`false`')}\n\n### 依赖和别的工具`)), /正好出现一次/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|\n| 系统 | x | `true` |')), /分隔行的列数/)
  assert.throws(() => parseChecks(doc('| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | <pre>false</pre> | `true` |')), /不能有 HTML/)
  assert.equal(parseChecks(doc("| 内容 | 版本 | 检查 |\n|---|---|---|\n| 系统 | x | `printf '#include <stdio.h>'` |")).length, 1)
  // 不该误报的：普通说明文字（含反引号）、行尾空格
  assert.equal(parseChecks(doc(`说明里有 \`code\` 和（括号）。\n\n${head}\n\n又一段说明。`)).length, 1)
  assert.equal(parseChecks(doc(head.replace('`true` |', '`true` |   '))).length, 1)
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
