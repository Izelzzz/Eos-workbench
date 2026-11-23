// 试用反馈第 1 条的端到端验证：agent 事先知道可写范围，范围外的位置改放到范围内并说明，不为路径问用户。
// 真实模型、内置 standard 工作流（developer 模板只能写 src/**、test/**、tests/**、docs/changes.md、package*.json）。
// 需求故意要求把代码写到 lib/clamp.js（范围外）。脚本用命令行跑任务；agent 提问时（调用进行中或对话尽头）记下问题，回答「按你的判断做」。
// 结果写到 <输出目录>/report.json，完整输出在 run.log。改动前后用同一个脚本跑，对比两份报告。
// 用法：node --import tsx scripts/write-scope-e2e.ts [输出目录名，默认 write-scope-e2e]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
/** 读任务状态。runner 正在写库时可能撞上锁，或库还没建出来：这一轮当作没读到，下一轮再读。 */
const read = () => {
  if (!existsSync(join(DATA, 'eos.db'))) return undefined
  try {
    const s = new Store(join(DATA, 'eos.db'))
    try {
      const [row] = s.list()
      return row === undefined ? undefined : s.get(row.id)
    } finally {
      s.close()
    }
  } catch {
    return undefined
  }
}

/** 运行一次 runner（run 或 resume）直到它退出；期间 agent 提问就回答。 */
const runOnce = async (args: string[]) => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args, '--no-wait', '--data', DATA], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', b => appendFileSync(LOG, b))
  child.stderr.on('data', b => appendFileSync(LOG, b))
  const exited = new Promise(r => child.on('exit', r))
  let done = false
  void exited.then(() => { done = true })
  appendFileSync(LOG, `\n$ eos ${args.join(' ')}\n`)
  while (!done) {
    await sleep(3000)
    const t = read()
    if (t?.question !== undefined && !questions.some(q => q.id === `${t.id}/${t.question!.id}`)) {
      questions.push({ id: `${t.id}/${t.question.id}`, source: t.question.source, node: t.question.node, text: t.question.text })
      eos('answer', t.id, '按你的判断做')
    }
  }
}

const questions: { id: string; source: string; node?: string; text: string }[] = []
await runOnce(['run', '--repo', REPO, REQUEST])
let id = read()?.id
for (let i = 0; i < 5 && id === undefined; i++) {
  await sleep(1000)
  id = read()?.id
}
if (id === undefined) throw new Error('没有建出任务，见 run.log')
for (let i = 0; i < 6 && read()?.status !== 'done' && read()?.status !== 'failed'; i++) await runOnce(['resume', id])

const store = new Store(join(DATA, 'eos.db'))
const t = store.get(id)!
const meta = store.meta(id)
store.close()
const calls = t.log.flatMap(e => (e.type === 'call' ? [e] : []))
const firstBuild = calls.find(c => c.node === 'build')
const files = execFileSync('git', ['diff', '--name-only', meta.baseSha, meta.branch], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(f => f !== '')
const reverted = calls.flatMap(c => (c.reverted ?? []).map(p => `${c.node}: ${p}`))
const pathQuestions = questions.filter(q => /lib|路径|目录|位置|范围/.test(q.text))
const build = calls.filter(c => c.node === 'build')

const report = {
  commit, task: id, status: t.status, request: REQUEST,
  checks: {
    '开发第一次调用的提示词里有可写范围': firstBuild?.prompt.includes('# 你的可写范围') ?? false,
    '开发第一次回复就没有越界（事先知道范围）': build.length > 0 && (build[0]!.reverted ?? []).length === 0,
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
