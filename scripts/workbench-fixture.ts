// 工作台截图和浏览器核对用的数据目录：几个停在不同位置的任务（agent 提问、等人验收、进行中）和一条待批的提案。
// 不调用模型：直接往存储里写事件，走的是真实的引擎。
// 用法：node --import tsx scripts/workbench-fixture.ts <数据目录> [--serve <端口>]
// --serve：建好后用这份数据起网页服务（web/dist，先 npm run build:web）。不用 eos web：它启动时会续跑没跑完的任务，
// 没有模型时任务会失败，截图就不是这里摆好的样子了。这里的 runner 永远不回复，任务停在摆好的位置。
// 时间是固定的（2026-11-28 中午前后），和 scripts/web-pixels.ts 固定的时钟对得上。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Credentials } from '../src/credentials/store.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { createWebServer } from '../src/web/server.ts'
import { FakeExecutor } from '../tests/fake-executor.ts'
import { PASS, workflow } from '../tests/helpers.ts'

const MARKER = '.workbench-fixture'
const [dir, flag, portArg] = process.argv.slice(2)
if (dir === undefined) throw new Error('用法：workbench-fixture.ts <数据目录> [--serve <端口>]')
// 只清空自己建的目录（有标记文件），或者空目录、不存在的目录：防止传错路径删掉真的数据目录
if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, MARKER))) throw new Error(`${dir} 不是空目录，也不是这个脚本建的，不动它`)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, MARKER), '')
const store = new Store(join(dir, 'eos.db'))
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const NOON = Date.parse('2026-11-28T12:00:00Z')
const min = (m: number) => NOON - m * 60_000
const meta = { repo: '/srv/eos/mirrors/eos-workbench', worktree: '/srv/eos/worktrees/x', branch: 'eos/x', baseSha: '0000000' }
const plain = workflow({ maxRounds: 2, escalate: false })
const gated = workflow({ maxRounds: 2, escalate: false, gate: 'human' })

/** 建一个任务，按顺序回复前几个调用 */
const task = (id: string, request: string, wf: typeof plain, replies: string[], at: number) => {
  store.create({ id, request, workflow: wf, workflowSource: 'y', meta: { ...meta, branch: `eos/${id}` } }, at)
  replies.forEach((text, i) => {
    const r = store.dispatch(id, { kind: 'replied', call: `c${i + 1}` as never, sessionId: 's', text, usage: zero, ms: 1 }, at + (i + 1) * 60_000, 'executor')
    if (!r.accepted) throw new Error(`${id} 的第 ${i + 1} 个回复没被接受`)
  })
}

task('t-0147', '导出任务列表为 CSV\n任务列表加一个导出 CSV 的按钮。', plain, ['方案'], min(16))
store.dispatch(
  't-0147',
  { kind: 'asked', call: 'c2' as never, question: { id: 'q1', text: '导出时要不要包含已中止的任务？', options: ['包含，并加一列「状态」', '不包含', '导出时让人选'] } },
  min(12),
  'executor',
)
task('t-0142', '任务列表支持按状态筛选', gated, ['方案', '实现', PASS], min(70))
task('t-0145', '统计页增加按仓库筛选', plain, ['方案', '实现'], min(30))
task('t-0146', '修复凭据页在窄屏下溢出', plain, ['方案'], min(20))
task('t-0144', 'doctor 的输出支持 JSON', gated, ['方案', '实现'], min(40))
task('t-0148', '凭据页支持批量删除', plain, [], min(3))
store.addProposal(
  {
    target: { kind: 'workflow', name: 'standard' },
    baseVersion: 12,
    content: 'name: standard',
    rationale: '开发阶段增加「改动要有对应测试」\n最近 4 个任务在评审时才发现没有补测试。',
    evidence: ['t-0140:3'],
    scope: { workflow: 'standard', tasks: ['t-0140'] },
    actor: 'cli',
  } as never,
  min(60 * 20),
)
console.log(`数据目录：${dir}`)
if (flag === '--serve') {
  const credentials = new Credentials(join(dir, 'eos.db'), undefined)
  const supervisor = new Supervisor({ store, executor: new FakeExecutor(() => new Promise<string>(() => {})), dataDir: dir, pollMs: 1000 })
  const server = createWebServer({ store, supervisor, replay: { traceOf: async () => [] }, staticDir: join(import.meta.dirname, '..', 'web', 'dist'), credentials })
  server.listen(Number(portArg ?? 43940), '127.0.0.1', () => console.log(`http://127.0.0.1:${portArg ?? 43940}`))
} else store.close()
