// 镜像的依赖探针（.github/workflows/image.yml 在构建、冒烟之后运行；PR 和发布都跑）。只用 Node 自带的模块。
// 1. 读 docs/deploy.md「执行器环境」那张表的「检查」一列，在镜像里以 agent 的用户（eos-agent）、断网逐条运行，退出码都必须是 0。
//    文档是唯一的清单：改表时一起改这一列，探针跟着变。解析不出来（找不到这一节、表、这一列，或某一行没写检查）直接失败。
// 2. 核对 Dockerfile 建的三个用户、两个组和 /data 的属主（ADR-006：平台、检查命令、agent 各一个用户）。
// 用法：node .github/scripts/image-probe.ts <镜像>
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Row = { item: string; checks: string[] }

/** 表格里转义的 \| 先换成这个占位，按 | 切完列再换回来 */
const PIPE = '\u{F8FF}'

/** 「## 执行器环境」下第一张表里每一行的「检查」：反引号里的命令，表格里的 \| 还原成 | */
export function parseChecks(markdown: string): Row[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex(l => l.trim() === '## 执行器环境')
  if (start < 0) throw new Error('docs/deploy.md 里找不到「## 执行器环境」一节')
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  const section = lines.slice(start + 1, end < 0 ? undefined : end)
  const first = section.findIndex(l => l.startsWith('|'))
  if (first < 0) throw new Error('「执行器环境」一节里找不到表')
  const table: string[] = []
  for (const l of section.slice(first)) {
    if (!l.startsWith('|')) break
    table.push(l)
  }
  const cells = (l: string) =>
    l
      .replaceAll('\\|', PIPE)
      .replace(/^\||\|$/g, '')
      .split('|')
      .map(c => c.trim().replaceAll(PIPE, '|'))
  const header = cells(table[0]!)
  const col = header.indexOf('检查')
  if (col < 0) throw new Error(`「执行器环境」的表里没有「检查」一列（表头：${header.join('、')}）`)
  if (table.length < 3 || !/^\|[-|: ]+\|$/.test(table[1]!)) throw new Error('「执行器环境」的表格式不对：第二行要是 |---|')
  return table.slice(2).map(l => {
    const c = cells(l)
    if (c.length !== header.length) throw new Error(`「执行器环境」的表里这一行列数不对：${l}`)
    const checks = [...c[col]!.matchAll(/`([^`]+)`/g)].map(m => m[1]!)
    if (checks.length === 0) throw new Error(`「执行器环境」的表里「${c[0]}」这一行没有写检查命令`)
    return { item: c[0]!, checks }
  })
}

/** Dockerfile 建的用户：useradd --uid N ... --groups a,b 名字 */
export type User = { name: string; uid: number; groups: string[] }
export function parseUsers(dockerfile: string): User[] {
  const users = [...dockerfile.matchAll(/useradd\s+[^\n&]*?--uid\s+(\d+)[^\n&]*?--groups\s+([\w,-]+)[^\n&]*?\s([a-z][\w-]*)\s*(?:\\|&&|$)/gm)].map(m => ({
    name: m[3]!,
    uid: Number(m[1]),
    groups: m[2]!.split(','),
  }))
  if (users.length === 0) throw new Error('Dockerfile 里找不到 useradd')
  return users
}

/** 在镜像里核对用户和 /data 属主的脚本（以 root 运行） */
export function usersScript(users: User[]): string {
  const lines = users.flatMap(u => [
    `test "$(id -u ${u.name})" = ${u.uid} || { echo "用户 ${u.name} 的 uid 不是 ${u.uid}"; exit 1; }`,
    ...u.groups.map(g => `id -nG ${u.name} | tr ' ' '\\n' | grep -qx ${g} || { echo "用户 ${u.name} 不在组 ${g} 里"; exit 1; }`),
  ])
  lines.push(`test "$(stat -c %U:%G /data)" = eos:eos || { echo "/data 的属主不是 eos:eos：$(stat -c %U:%G /data)"; exit 1; }`)
  return lines.join('\n')
}

if (import.meta.main) {
  const image = process.argv[2]
  if (image === undefined) {
    console.log('::error title=依赖探针::用法：image-probe.ts <镜像>')
    process.exit(1)
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const rows = parseChecks(readFileSync(join(root, 'docs/deploy.md'), 'utf8'))
  const users = parseUsers(readFileSync(join(root, 'Dockerfile'), 'utf8'))
  const run = (user: string, script: string) => spawnSync('docker', ['run', '--rm', '--network', 'none', '--user', user, '--entrypoint', 'bash', image, '-c', script], { encoding: 'utf8' })
  let failed = 0
  for (const row of rows) {
    for (const check of row.checks) {
      const r = run('eos-agent', check)
      const ok = r.status === 0
      console.log(`${ok ? '✓' : '✗'} ${row.item}：${check}${ok ? '' : `（退出码 ${r.status}）${(r.stdout + r.stderr).trim().slice(0, 300)}`}`)
      if (!ok) failed++
    }
  }
  const u = run('root', usersScript(users))
  console.log(`${u.status === 0 ? '✓' : '✗'} 用户和 /data 属主：${users.map(x => `${x.name}(${x.uid}; ${x.groups.join(',')})`).join('、')}${u.status === 0 ? '' : `：${(u.stdout + u.stderr).trim()}`}`)
  if (u.status !== 0) failed++
  if (failed > 0) {
    console.log(`::error title=依赖探针::镜像里有 ${failed} 项检查没通过（见上面的 ✗）。改了 Dockerfile 的话，要么补上依赖，要么同步改 docs/deploy.md「执行器环境」的表`)
    process.exit(1)
  }
  console.log(`依赖探针通过：${rows.reduce((n, r) => n + r.checks.length, 0)} 条检查，${users.length} 个用户`)
}
