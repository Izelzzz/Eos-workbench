// 镜像的依赖探针（.github/workflows/image.yml 在构建、冒烟之后运行；PR 和发布都跑）。只用 Node 自带的模块。
// 1. 读 .github/scripts/image-probe-checks.json 的检查，在镜像里以 agent 的用户（eos-agent）、断网逐条运行，退出码都必须是 0。
//    docs/deploy.md「执行器环境」的表是给人看的同一份清单，tests/image-probe.test.ts 核对两边一致。
// 2. 核对三个用户的 uid 和组（完全一致）、/data 的属主（ADR-006：平台、检查命令、agent 各一个用户）。
// 探针用镜像本身的环境，不经过 dsh 的环境白名单和沙箱；那两样另有测试（tests/agent-env-contract.test.ts）和实测。
// 用法：node .github/scripts/image-probe.ts <镜像>
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Row = { item: string; checks: string[] }

/**
 * 检查清单在 .github/scripts/image-probe-checks.json：探针只读它，不解析 Markdown。
 * 以前从 docs/deploy.md 的表里读，几轮独立审查都找到了让页面显示的检查和实际执行的不一样的 Markdown 写法（注释里的假小节、
 * 标题变体、HTML 表格……），所以改成机器读的文件；文档里的表给人看，tests/image-probe.test.ts 核对两边一致。
 * 这里在边界上校验格式：认不出就报错，不跳过。
 */
export function parseChecks(json: string): Row[] {
  const data = JSON.parse(json) as unknown
  const items = (data as { items?: unknown }).items
  if (!Array.isArray(items) || items.length === 0) throw new Error('image-probe-checks.json 里要有非空的 items 数组')
  return items.map((x, i) => {
    const r = x as { item?: unknown; checks?: unknown }
    if (typeof r.item !== 'string' || r.item.trim() === '') throw new Error(`image-probe-checks.json 第 ${i + 1} 项缺 item`)
    if (!Array.isArray(r.checks) || r.checks.length === 0 || !r.checks.every(c => typeof c === 'string' && c.trim() !== '')) {
      throw new Error(`image-probe-checks.json 里「${r.item}」的 checks 要是非空的字符串数组`)
    }
    return { item: r.item, checks: r.checks as string[] }
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
  const rows = parseChecks(readFileSync(join(root, '.github/scripts/image-probe-checks.json'), 'utf8'))
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
    console.log(
      `::error title=依赖探针::镜像里有 ${failed} 项检查没通过（见上面的 ✗）。改了 Dockerfile 的话，要么补上依赖，要么同步改 .github/scripts/image-probe-checks.json 和 docs/deploy.md「执行器环境」的表`,
    )
    process.exit(1)
  }
  console.log(`依赖探针通过：${rows.reduce((n, r) => n + r.checks.length, 0)} 条检查，${EXPECTED_USERS.length} 个用户`)
}
