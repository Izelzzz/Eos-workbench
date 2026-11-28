// 对话 agent 提议建任务、人确认创建的端到端验证：真实的 dsh、平台 MCP 端点；经命令行请 agent 在一个用过的仓库上建任务。
// 核对：
// - 发给模型的工具表里有 list_repos 和 propose_task，全是平台工具；agent 用了 list_repos 和 propose_task；
// - 记下了一条没有作废的任务提议：仓库是 list_repos 列出的 demo 仓库，工作流 standard；任务表一行都没多；
// - eos chat show 列出任务提议和创建命令；
// - 人改了需求之后创建（和 eos chat create 同一个函数，只建不运行：运行任务要再调模型）：任务的需求是改过的，meta 记下来源；
//   之后用命令行 eos chat create 再建一次被拒绝；
// - 平台持有的模型 key 不在对话记录、任务提议、对话 trace 和命令输出里。
// 用法：node --import tsx scripts/chat-task-e2e.ts [--fake]
//   --fake：用假模型（不花钱，本地联调）。不加就是真实模型，报告写进 docs/e2e/chat-d1/report.json。
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { createFromProposal } from '../src/chat/create.ts'
import { ChatStore } from '../src/chat/store.ts'
import { PROPOSE_TASK_TOOL } from '../src/chat/tasks.ts'
import { TOOLS } from '../src/chat/tools.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { DshExecutor, dshInstall } from '../src/executor/dsh.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { startFakeModel } from './fake-model/server.ts'
import type { Reply, Request } from './fake-model/script.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'chat-task-e2e')
const DATA = join(OUT, 'data')
const fake = process.argv.includes('--fake')
const KEY = fake ? 'fake-model-key-0123456789' : (process.env.DEEPSEEK_API_KEY ?? 'proxy-injected')
const ASK = '帮我建一个任务：在 demo 仓库里给 README.md 加一节「安装」，写清楚怎么安装依赖。用 standard 工作流。'
const EDITED = '在 README.md 里加一节「安装」，写清楚怎么安装依赖；另外加一节「测试」。'

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' })
const codeState = () => ({
  commit: git(ROOT, 'rev-parse', 'HEAD').trim(),
  uncommitted: git(ROOT, 'status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(l => l !== ''),
})

rmSync(OUT, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
const atStart = codeState()

// 两个本机仓库，各有一个以前的任务：它们是「用过的仓库」。agent 要从 list_repos 里认出 demo。
const repoAt = (name: string) => {
  const dir = join(OUT, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init')
  return dir
}
const demo = repoAt('demo')
const other = repoAt('billing')
{
  const store = new Store(join(DATA, 'eos.db'))
  const conventions = new Conventions(store)
  conventions.seed(Date.now())
  const wf = conventions.resolve('standard')
  if (!wf.ok) throw new Error(wf.error)
  for (const [id, repo, at] of [
    ['t-old-1', other, 1],
    ['t-old-2', demo, 2],
  ] as const)
    store.create({ id, request: '以前的任务', workflow: wf.workflow, workflowSource: wf.source, meta: { repo, worktree: '/w', branch: `eos/${id}`, baseSha: '0'.repeat(40) } }, at)
  store.close()
}
const tasksDump = () => JSON.stringify(new DatabaseSync(join(DATA, 'eos.db')).prepare('SELECT id FROM tasks ORDER BY id').all())
const before = tasksDump()

// 假模型：列仓库 → 提一个用了没列出的仓库的（被退回）→ 提改好的 → 回答。
const requests: Request[] = []
const script = (req: Request): Reply => {
  requests.push(req)
  const done = req.messages.flatMap(m => m.content.filter(b => b.type === 'tool_result')).length
  const tool = `mcp__eos__${PROPOSE_TASK_TOOL}`
  if (done === 0) return { kind: 'tool', name: 'mcp__eos__list_repos', input: {} }
  if (done === 1) return { kind: 'tool', name: tool, input: { title: '加安装说明', repo: '/somewhere/demo', workflow: 'standard', request: '加一节安装' } }
  if (done === 2) return { kind: 'tool', name: tool, input: { title: '加安装说明', repo: demo, workflow: 'standard', request: '在 README.md 里加一节「安装」' } }
  return { kind: 'text', text: '已经提议了任务，等你确认后创建。' }
}
const model = fake ? await startFakeModel(() => {}, script) : undefined

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'EOS_MODEL_BASE_URL' && k !== 'DEEPSEEK_BASE_URL' && k !== 'EOS_MASTER_KEY')),
  NODE_USE_ENV_PROXY: '1',
  DEEPSEEK_API_KEY: KEY,
  ...(model === undefined ? {} : { EOS_MODEL_BASE_URL: model.baseUrl }),
}
const run = promisify(execFile)
const outputs: string[] = []
// 异步：假模型在本进程里，同步等待会让它没法回复。
const eos = async (...args: string[]) => {
  try {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args, '--data', DATA], { cwd: ROOT, env, encoding: 'utf8', timeout: 900_000 })
    outputs.push(stdout)
    return { code: 0, out: stdout }
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string }
    const out = `${x.stdout ?? ''}${x.stderr ?? ''}`
    outputs.push(out)
    return { code: 1, out }
  }
}

const first = await eos('chat', 'new', ASK)
const id = /chat send (c[0-9a-z]+)/.exec(first.out)?.[1]
const show = id === undefined ? { code: 1, out: '' } : await eos('chat', 'show', id)
await model?.close()
const beforeCreate = tasksDump()

const store = new Store(join(DATA, 'eos.db'))
const chats = new ChatStore(store.db)
const proposals = id === undefined ? [] : chats.taskProposals(id)
const target = proposals.find(p => p.voided === undefined)
// 人确认：改了需求再创建。和 eos chat create 同一个函数、同一个 Supervisor.create，只是不运行任务（运行要再调模型）。
const sup = new Supervisor({ store, executor: { send: () => Promise.reject(new Error('不运行')), findReply: async () => undefined, traceOf: async () => [], release: async () => {}, close: async () => {} }, dataDir: DATA })
const created = target === undefined ? undefined : await createFromProposal({ chats, create: i => sup.create(i), dataDir: DATA, redact: s => s.split(KEY).join('***'), id: target.id, actor: 'cli', edits: { request: EDITED }, now: Date.now })
const again = target === undefined ? { code: 0, out: '' } : await eos('chat', 'create', String(target.id))
const showAfter = id === undefined ? { code: 1, out: '' } : await eos('chat', 'show', id)

const db = new DatabaseSync(join(DATA, 'eos.db'))
const messages = db.prepare('SELECT role, text, call FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(id ?? '') as { role: string; text: string; call: string | null }[]
const chatTrace = db.prepare('SELECT event FROM chat_trace WHERE chat_id = ?').all(id ?? '') as { event: string }[]
const rows = db.prepare('SELECT * FROM chat_task_proposals WHERE chat_id = ? ORDER BY id').all(id ?? '')
const reads = messages.flatMap(m => (m.call === null ? [] : (JSON.parse(m.call) as { reads: { tool: string; isError: boolean }[] }).reads))
const offered = id === undefined ? [] : new DshExecutor({ dshHome: join(DATA, 'dsh'), dshBin: dshInstall(ROOT)!.bin, modelKey: () => KEY }).toolsOffered(`chat/${id}`)
const task = created?.ok === true ? store.get(created.taskId) : undefined
const meta = created?.ok === true ? store.meta(created.taskId) : undefined

const checks: [string, boolean, unknown][] = [
  ['命令成功，有回复', first.code === 0 && messages.map(m => m.role).join(',') === 'user,assistant', first.out.slice(-1500)],
  [
    '发给模型的工具表：9 个只读工具和两个提议工具，全是平台工具',
    offered.length === TOOLS.length + 2 && offered.includes(`mcp__eos__${PROPOSE_TASK_TOOL}`) && offered.includes('mcp__eos__list_repos') && offered.every(t => t.startsWith('mcp__eos__')),
    offered,
  ],
  ['agent 用了 list_repos 和 propose_task', reads.some(r => r.tool === 'list_repos') && reads.some(r => r.tool === PROPOSE_TASK_TOOL), reads],
  ['记下一条没有作废的任务提议：仓库是 demo，工作流 standard', target?.input.repo === demo && target.input.workflow === 'standard', proposals],
  ['创建之前任务表一行都没多', beforeCreate === before, undefined],
  ['eos chat show 列出任务提议和创建命令', target !== undefined && show.out.includes(`任务提议 #${target.id}`) && show.out.includes(`chat create ${target.id}`), show.out.split('\n').filter(l => l.includes('任务提议') || l.includes('create'))],
  [
    '人改了需求后创建：任务的需求是改过的，meta 记下来源，提议记下建成的任务',
    created?.ok === true && task?.request === EDITED && meta?.origin === `来自对话 ${id} 的任务提议 #${target?.id}` && chats.taskProposal(target!.id)?.created?.taskId === created.taskId,
    { created, request: task?.request, origin: meta?.origin },
  ],
  ['eos chat create 再建一次被拒绝', again.code !== 0 && again.out.includes('已经创建过'), again.out.slice(-300)],
  ['创建后 eos chat show 显示已创建', created?.ok === true && showAfter.out.includes(`已创建任务 ${created.taskId}（cli，`), undefined],
  ['平台持有的模型 key 不在对话记录、任务提议、对话 trace 和命令输出里', !JSON.stringify([messages, rows, chatTrace]).includes(KEY) && !outputs.join('\n').includes(KEY), undefined],
]
store.close()

const atEnd = codeState()
const report = {
  mode: fake ? 'fake-model' : 'real-model',
  ...atStart,
  commitAtEnd: atEnd.commit,
  chat: id,
  checks: checks.map(([name, ok, detail]) => ({ name, ok, ...(detail === undefined ? {} : { detail }) })),
  transcript: show.out,
  transcriptAfterCreate: showAfter.out,
  taskProposals: rows,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
if (!fake) {
  const evidence = join(ROOT, 'docs', 'e2e', 'chat-d1')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
}
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log(`\n报告：${join(OUT, 'report.json')}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
