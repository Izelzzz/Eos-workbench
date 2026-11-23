// 试用反馈第 1 条的端到端验证：agent 事先知道可写范围，范围外的位置改放到范围内并说明，不为路径问用户。
// 真实模型、内置 standard 工作流（developer 模板只能写 src/**、test/**、tests/**、docs/changes.md、package*.json）。
// 需求故意要求把代码写到 lib/clamp.js（范围外）。脚本用命令行跑任务；agent 提问时记下问题、回答「按你的判断」后续跑。
// 结果写到 <输出目录>/report.json，完整输出在 run.log。改动前后用同一个脚本跑，对比两份报告。
// 用法：node --import tsx scripts/write-scope-e2e.ts [输出目录名，默认 write-scope-e2e]
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/store/store.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', process.argv[2] ?? 'write-scope-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const LOG = join(OUT, 'run.log')
const REQUEST = '在 lib/clamp.js 实现并导出 clamp(value, min, max)：把数字限制在 [min, max] 之间；min 大于 max 时抛 RangeError。用 node:test 写测试放在 test/ 目录，npm test 必须通过。'
const env = { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }

const eos = (...args: string[]): string => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args, '--data', DATA], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1 << 30 })
  appendFileSync(LOG, `\n$ eos ${args.join(' ')}\n${r.stdout}${r.stderr}`)
  return r.stdout + r.stderr
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
writeFileSync(join(REPO, 'README.md'), '# demo\n')
for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })

const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const out = eos('run', '--repo', REPO, '--no-wait', REQUEST)
const id = /任务 (t\w+)：/.exec(out)?.[1]
if (id === undefined) throw new Error(`没拿到任务 id：\n${out}`)

const questions: { source: string; text: string }[] = []
for (let i = 0; i < 6; i++) {
  const store = new Store(join(DATA, 'eos.db'))
  const t = store.get(id)!
  store.close()
  if (t.status !== 'waiting_user') break
  questions.push({ source: t.question!.source, text: t.question!.text })
  eos('answer', id, '按你的判断做')
  eos('resume', id, '--no-wait')
}

const store = new Store(join(DATA, 'eos.db'))
const t = store.get(id)!
const meta = store.meta(id)
store.close()
const calls = t.log.flatMap(e => (e.type === 'call' ? [e] : []))
const firstBuild = calls.find(c => c.node === 'build')
const files = execFileSync('git', ['diff', '--name-only', meta.baseSha, meta.branch], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(f => f !== '')
const reverted = calls.flatMap(c => (c.reverted ?? []).map(p => `${c.node}: ${p}`))
const pathQuestions = questions.filter(q => /lib|路径|目录|位置|范围/.test(q.text))

const report = {
  commit, task: id, status: t.status, request: REQUEST,
  checks: {
    '开发第一次调用的提示词里有可写范围': firstBuild?.prompt.includes('# 你的可写范围') ?? false,
    '没有为路径向用户提问': pathQuestions.length === 0,
    '没有越界改动被撤销': reverted.length === 0,
    '任务分支里没有 lib/ 下的文件': !files.some(f => f.startsWith('lib/')),
    'clamp 实现放在了 src/ 下': files.some(f => /^src\/.*clamp/.test(f)),
    '开发的回复里提到了 lib/（说明改放的位置）': calls.filter(c => c.node === 'build').some(c => c.reply.includes('lib/')),
    '任务完成': t.status === 'done',
  },
  questions, reverted, files,
  buildReplies: calls.filter(c => c.node === 'build').map(c => c.reply),
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
const passed = Object.values(report.checks).filter(Boolean).length
console.log(`${passed}/${Object.keys(report.checks).length} 通过（提交 ${commit}，任务 ${id}，${t.status}）`)
for (const [k, v] of Object.entries(report.checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
