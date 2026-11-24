// 试用反馈第 2 条的端到端验证：启动检查和 eos doctor。实际运行命令行，不打桩：
// 1. 用低于要求的 Node（运行本脚本的 node）：doctor 报 ⚠ Node（只提示）并给出修法、退出码 0；run 提示后照常启动，用真实模型把任务跑完。
// 2. 用符合要求的 Node（参数给出路径）但不设 DEEPSEEK_API_KEY：run、web 不启动，说清怎么修，也不建数据库。
// 3. 数据目录放在一个普通文件下面：doctor 报 ✗ 数据目录。
// 4. 符合要求的 Node + key：doctor 全部 ✓、退出码 0；run 用真实模型把一个小任务跑完。
// 结果写到 .eos/doctor-e2e/report.json，每条命令的输出在 run.log。
// 用法：node --import tsx scripts/doctor-e2e.ts <Node 24 的 node 路径>
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'doctor-e2e')
const REPO = join(OUT, 'repo')
const LOG = join(OUT, 'run.log')
const node24 = process.argv[2]
if (node24 === undefined) throw new Error('用法：node --import tsx scripts/doctor-e2e.ts <Node 24 的 node 路径>')

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })
writeFileSync(join(OUT, 'a-file'), '')

/** 用指定的 node 跑 eos 命令。env 只给 PATH、代理和显式传入的变量，不继承别的。 */
const eos = (nodeBin: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync(nodeBin, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30,
    env: { PATH: process.env.PATH!, HTTPS_PROXY: process.env.HTTPS_PROXY ?? '', NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS ?? '', NODE_USE_ENV_PROXY: '1', ...env },
  })
  const out = `${r.stdout}${r.stderr}`.split('\n').filter(l => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n')
  appendFileSync(LOG, `\n$ [node ${spawnSync(nodeBin, ['-v'], { encoding: 'utf8' }).stdout.trim()}] eos ${args.join(' ')}${env.DEEPSEEK_API_KEY ? '（设置了 DEEPSEEK_API_KEY）' : ''}\n退出码 ${r.status}\n${out}\n`)
  return { status: r.status, out }
}

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const KEY = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }
const data = (n: string) => join(OUT, `data-${n}`)

const oldDoctor = eos(process.execPath, ['doctor', '--data', data('old')], KEY)
const TASK = '在 src/add.js 实现并导出 add(a, b)，返回两数之和；用 node:test 写测试放在 test/ 目录，npm test 必须通过。不需要问我任何问题，有歧义按最简单的做法。'
const oldRun = eos(process.execPath, ['run', '--repo', REPO, '--no-wait', '--data', data('old'), TASK], KEY)
const noKeyRun = eos(node24, ['run', '--repo', REPO, '--data', data('nokey'), '加一个函数'], {})
const noKeyWeb = eos(node24, ['web', '--port', '4339', '--data', data('nokey')], {})
const badDir = eos(node24, ['doctor', '--data', join(OUT, 'a-file', 'data')], KEY)
const okDoctor = eos(node24, ['doctor', '--data', data('ok')], KEY)
const okRun = eos(node24, ['run', '--repo', REPO, '--no-wait', '--data', data('ok'),
  TASK], KEY)

const report = {
  commit, node: { old: process.version, required: spawnSync(node24, ['-v'], { encoding: 'utf8' }).stdout.trim() },
  checks: {
    'Node 低于要求：doctor 报 ⚠ Node、给出修法、退出码 0': oldDoctor.status === 0 && /⚠ Node：.*低于 Eos 要求的 >=24\.9\.0[\s\S]*怎么修：安装 Node 24\.9\.0/.test(oldDoctor.out) && !oldDoctor.out.includes('✗'),
    'Node 低于要求：run 先提示，再照常用真实模型把任务跑完': oldRun.status === 0 && /启动前检查有提示（照常启动）：\n⚠ Node/.test(oldRun.out) && /任务 t\w+：已完成/.test(oldRun.out),
    '没有 key：run 不启动，说明怎么设置': noKeyRun.status === 1 && /✗ DeepSeek API key：没有设置环境变量 DEEPSEEK_API_KEY\n  怎么修：/.test(noKeyRun.out),
    '没有 key：web 不启动': noKeyWeb.status === 1 && /启动前检查没有通过/.test(noKeyWeb.out),
    '没有 key 时不建数据库': !existsSync(join(data('nokey'), 'eos.db')),
    '数据目录不可用：doctor 报 ✗ 数据目录（中文原因）': badDir.status === 1 && /✗ 数据目录：.*路径里有一段不是目录/.test(badDir.out),
    '环境都满足：doctor 全部 ✓、退出码 0': okDoctor.status === 0 && !okDoctor.out.includes('✗') && (okDoctor.out.match(/✓/g) ?? []).length === 5,
    '环境都满足：run 通过检查，用真实模型把任务跑完': okRun.status === 0 && /任务 t\w+：已完成/.test(okRun.out),
  },
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const passed = Object.values(report.checks).filter(Boolean).length
console.log(`${passed}/${Object.keys(report.checks).length} 通过（提交 ${commit}）`)
for (const [k, v] of Object.entries(report.checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
