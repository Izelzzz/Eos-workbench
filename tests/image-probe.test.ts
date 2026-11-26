import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPECTED_USERS, parseChecks, parseUsers, usersScript } from '../.github/scripts/image-probe.ts'

const ROOT = join(import.meta.dirname, '..')
const checks = parseChecks(readFileSync(join(ROOT, '.github/scripts/image-probe-checks.json'), 'utf8'))

/** docs/deploy.md「### 镜像里有什么」那张表：每一行的第一列和「检查」一列反引号里的命令（表格里的 \| 还原成 |）。只用来和 JSON 对照 */
function docTable(markdown: string): { item: string; checks: string[] }[] {
  const lines = markdown.split('\n')
  const start = lines.indexOf('### 镜像里有什么')
  assert.ok(start >= 0, 'docs/deploy.md 里找不到「### 镜像里有什么」')
  const rows = lines.slice(start + 1).filter((l, i, a) => l.startsWith('|') && a.slice(0, i).every(p => !/^#{1,3} /.test(p)))
  const cells = (l: string) =>
    l
      .replaceAll('\\|', '\u{F8FF}')
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(c => c.trim().replaceAll('\u{F8FF}', '|'))
  const header = cells(rows[0]!)
  const col = header.indexOf('检查')
  assert.ok(col >= 0, '表里没有「检查」一列')
  return rows.slice(2).map(l => {
    const c = cells(l)
    return { item: c[0]!, checks: [...c[col]!.matchAll(/`([^`]+)`/g)].map(m => m[1]!) }
  })
}

test('docs/deploy.md「镜像里有什么」的表和 image-probe-checks.json 一致（文档给人看，探针只执行 JSON）', () => {
  assert.deepEqual(docTable(readFileSync(join(ROOT, 'docs/deploy.md'), 'utf8')), checks)
  assert.deepEqual(
    checks.map(r => r.item),
    ['系统', 'Node、npm', 'pnpm、yarn', 'Python', '编译', '其他'],
  )
  assert.ok(checks.flatMap(r => r.checks).includes("node --version | grep -q '^v24\\.'"))
})

test('image-probe-checks.json 在边界上校验格式，认不出就报错', () => {
  assert.deepEqual(parseChecks('{"items":[{"item":"系统","checks":["true"]}]}'), [{ item: '系统', checks: ['true'] }])
  for (const bad of [
    '{}',
    '{"items":[]}',
    '{"items":[{"checks":["true"]}]}',
    '{"items":[{"item":"a","checks":[]}]}',
    '{"items":[{"item":"a","checks":["  "]}]}',
    '{"items":[{"item":"a","checks":[1]}]}',
    'not json',
  ]) {
    assert.throws(() => parseChecks(bad), undefined, bad)
  }
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
