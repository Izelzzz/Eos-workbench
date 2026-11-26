// 镜像的依赖探针（.github/workflows/image.yml 在构建、冒烟之后运行；PR 和发布都跑）。只用 Node 自带的模块。
// 1. 读 docs/deploy.md「执行器环境」那张表的「检查」一列，在镜像里以 agent 的用户（eos-agent）、断网逐条运行，退出码都必须是 0。
//    文档是唯一的清单：改表时一起改这一列，探针跟着变。解析不出来（找不到这一节、表、这一列，或某一行没写检查）直接失败。
// 2. 核对三个用户的 uid 和组（完全一致）、/data 的属主（ADR-006：平台、检查命令、agent 各一个用户）。
// 探针用镜像本身的环境，不经过 dsh 的环境白名单和沙箱；那两样另有测试（tests/agent-env-contract.test.ts）和实测。
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
  const section = lines.slice(start + 1, end < 0 ? undefined : end).map(l => l.trimEnd())
  // 这一节里只许有一张表。表从第一条以 | 开头的行起，到第一个空行止（GFM 的表在空行处结束）；
  // 表里每一行都要以 | 开头、前面不缩进。GFM 里不写 | 或缩进的行照样算表格的一行，但容易被看漏，一律报错
  const first = section.findIndex(l => /^\s*\|/.test(l))
  if (first < 0) throw new Error('「执行器环境」一节里找不到表')
  const table: string[] = []
  let i = first
  for (; i < section.length && section[i] !== ''; i++) {
    if (!section[i]!.startsWith('|')) throw new Error(`「执行器环境」的表里这一行要以 | 开头、前面不缩进：${section[i]}`)
    table.push(section[i]!)
  }
  // 表后面（代码块之外）再出现表格行或分隔行（|---|、--|--），说明有第二张表或表被空行断开了
  let fenced = false
  for (const l of section.slice(i)) {
    if (/^\s*(```|~~~)/.test(l)) fenced = !fenced
    if (!fenced && (/^\s*\|/.test(l) || /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l))) {
      throw new Error(`「执行器环境」一节里表后面还有表格行（表中间不能有空行，这一节只能有一张表）：${l}`)
    }
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
    // 双反引号写法（``a `b` ``）会被切成几段、每段都不完整，直接报错
    if (c[col]!.includes('``')) throw new Error(`「执行器环境」的表里「${c[0]}」这一行的检查不能用双反引号`)
    const checks = [...c[col]!.matchAll(/`([^`]+)`/g)].map(m => m[1]!.trim())
    if (checks.length === 0) throw new Error(`「执行器环境」的表里「${c[0]}」这一行没有写检查命令`)
    if (checks.some(x => x === '')) throw new Error(`「执行器环境」的表里「${c[0]}」这一行有空的检查命令`)
    return { item: c[0]!, checks }
  })
}

/**
 * 镜像里应该有的用户：按 ADR-006 写死，不从 Dockerfile 读（从 Dockerfile 读的话，Dockerfile 改坏了期望值也跟着变，查不出来）。
 * 组要完全一致：比如给 eos-check 多加一个 eos-dsh，检查命令就能读 dsh 的数据目录，必须拦下。
 */
export type User = { name: string; uid: number; groups: string[] }
export const EXPECTED_USERS: User[] = [
  { name: 'eos', uid: 10001, groups: ['eos', 'eos-dsh', 'eos-work'] },
  { name: 'eos-check', uid: 10002, groups: ['eos-check', 'eos-work'] },
  { name: 'eos-agent', uid: 10003, groups: ['eos-agent', 'eos-dsh', 'eos-work'] },
]

/** Dockerfile 里的 useradd（单元测试拿它和 EXPECTED_USERS 对照，改 Dockerfile 时两边一起改）。认不出的 useradd 直接报错 */
export function parseUsers(dockerfile: string): User[] {
  const calls = dockerfile
    .replace(/\\\n/g, ' ')
    .split(/useradd\s/)
    .slice(1)
    .map(c => c.split(/&&|\n/)[0]!)
  if (calls.length === 0) throw new Error('Dockerfile 里找不到 useradd')
  return calls.map(c => {
    const uid = /--uid\s+(\d+)/.exec(c)
    const groups = /--groups\s+([\w,-]+)/.exec(c)
    const name = /\s([a-z][\w-]*)\s*$/.exec(` ${c}`)
    if (uid === null || groups === null || name === null) throw new Error(`Dockerfile 里这条 useradd 认不出来：useradd ${c.trim()}`)
    return { name: name[1]!, uid: Number(uid[1]), groups: groups[1]!.split(',') }
  })
}

/** 在镜像里核对用户（uid、组完全一致）和 /data 属主的脚本（以 root 运行；全部查完再退出） */
export function usersScript(users: User[]): string {
  const lines = users.flatMap(u => {
    const want = [...u.groups].sort().join(' ')
    return [
      `test "$(id -u ${u.name})" = ${u.uid} || { echo "用户 ${u.name} 的 uid 不是 ${u.uid}"; fail=1; }`,
      `g="$(id -nG ${u.name} | tr ' ' '\\n' | LC_ALL=C sort | xargs)"; test "$g" = "${want}" || { echo "用户 ${u.name} 的组是 $g，应该是 ${want}"; fail=1; }`,
    ]
  })
  lines.push(`test "$(stat -c %U:%G /data)" = eos:eos || { echo "/data 的属主不是 eos:eos：$(stat -c %U:%G /data)"; fail=1; }`)
  // 每项都查完再退出，一次报出全部问题
  return ['fail=0', ...lines, 'exit $fail'].join('\n')
}

if (import.meta.main) {
  const image = process.argv[2]
  if (image === undefined) {
    console.log('::error title=依赖探针::用法：image-probe.ts <镜像>')
    process.exit(1)
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const rows = parseChecks(readFileSync(join(root, 'docs/deploy.md'), 'utf8'))
  /** 每条检查一个新容器；卡住的命令（比如等标准输入）2 分钟后算失败，不拖到 job 超时 */
  const run = (user: string, script: string): { ok: boolean; detail: string } => {
    const r = spawnSync('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--user', user, '--entrypoint', 'bash', image, '-c', script], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (r.error !== undefined) return { ok: false, detail: `（docker 没有跑完：${r.error.message}）` }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().slice(0, 300)
    return r.status === 0 ? { ok: true, detail: '' } : { ok: false, detail: `（退出码 ${r.status ?? r.signal}）${out}` }
  }
  let failed = 0
  for (const row of rows) {
    for (const check of row.checks) {
      const r = run('eos-agent', check)
      console.log(`${r.ok ? '✓' : '✗'} ${row.item}：${check}${r.detail}`)
      if (!r.ok) failed++
    }
  }
  const u = run('root', usersScript(EXPECTED_USERS))
  console.log(`${u.ok ? '✓' : '✗'} 用户和 /data 属主：${EXPECTED_USERS.map(x => `${x.name}(${x.uid}; ${x.groups.join(',')})`).join('、')}${u.detail}`)
  if (!u.ok) failed++
  if (failed > 0) {
    console.log(`::error title=依赖探针::镜像里有 ${failed} 项检查没通过（见上面的 ✗）。改了 Dockerfile 的话，要么补上依赖，要么同步改 docs/deploy.md「执行器环境」的表`)
    process.exit(1)
  }
  console.log(`依赖探针通过：${rows.reduce((n, r) => n + r.checks.length, 0)} 条检查，${EXPECTED_USERS.length} 个用户`)
}
