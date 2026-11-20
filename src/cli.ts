// eos 命令行：创建任务、运行、续跑、回答、查看。数据目录默认 ~/.eos，可用 --data 或 EOS_HOME 指定。
import { describeCheck } from './engine/checks.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { describePosition } from './engine/machine.ts'
import { formatReport, report } from './engine/report.ts'
import type { Task } from './engine/types.ts'
import { DshExecutor } from './executor/dsh.ts'
import { diffStat } from './runner/git.ts'
import { Supervisor } from './runner/supervisor.ts'
import { Store } from './store/store.ts'
import { createWebServer } from './web/server.ts'
import { builtinTemplates, loadWorkflow } from './workflow/templates.ts'

const HELP = `用法：
  eos run --repo <仓库路径> [--workflow feature] "<需求>"   创建任务并运行
  eos resume <任务>                                       续跑（进程中断后）
  eos retry <任务>                                        重试失败的任务
  eos answer <任务> "<回答>"                              回答 agent 的提问或对话尽头的问题
  eos status [任务]                                       列出任务，或查看一个任务
  eos log <任务>                                          完整对话记录与耗时、token 统计
  eos abort <任务>                                        中止任务
  eos workflows                                           列出内置工作流
  eos web [--port 4317]                                   打开 Web 界面（任务列表与 trace 详情）

选项：--data <目录>（默认 $EOS_HOME 或 ~/.eos）  --no-wait（需要用户回答时直接退出）`

const STATUS: Record<Task['status'], string> = { running: '运行中', waiting_user: '等待回答', done: '已完成', failed: '失败', aborted: '已中止' }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: 'string' }, workflow: { type: 'string', default: 'feature' }, data: { type: 'string' }, 'no-wait': { type: 'boolean', default: false }, port: { type: 'string', default: '4317' }, help: { type: 'boolean', short: 'h' } },
})

const dataDir = resolve(values.data ?? process.env.EOS_HOME ?? join(homedir(), '.eos'))
mkdirSync(dataDir, { recursive: true })
const store = new Store(join(dataDir, 'eos.db'))
const say = (s: string): void => void process.stdout.write(`${s}\n`)
const fail = (s: string): never => {
  process.stderr.write(`${s}\n`)
  process.exit(1)
}

const dshBin = (): string => {
  const bin = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) fail(`找不到 dsh：${bin}，先运行 npm install`)
  return bin
}

const taskOf = (id: string | undefined): Task => {
  if (id === undefined) return fail('需要任务 id')
  return store.get(id) ?? fail(`没有任务 ${id}`)
}

const showQuestion = (t: Task) => {
  if (t.question === undefined) return
  say(`\n待回答（${t.question.id}）：${t.question.text}${t.question.options ? `\n选项：${t.question.options.join(' / ')}` : ''}`)
  say(`回答：npm run eos -- answer ${t.id} "<回答>"`)
}

const summary = (t: Task) => {
  say(`\n任务 ${t.id}：${STATUS[t.status]} · ${describePosition(t)}`)
  if (t.failure !== undefined) say(`失败原因：${t.failure}\n重试：npm run eos -- retry ${t.id}`)
  showQuestion(t)
  if (t.status === 'done') {
    const meta = store.meta(t.id)
    say(`\n分支 ${meta.branch}，worktree ${meta.worktree}\n${diffStat(meta)}`)
  }
  say(`\n${formatReport(report(t))}`)
}

const executor = () => new DshExecutor({ dshHome: join(dataDir, 'dsh'), dshBin: dshBin() })

/** 在本进程里运行一个任务直到结束（或在 --no-wait 时停在需要用户回答的地方）。 */
const run = async (id: string | ((sup: Supervisor) => string)) => {
  const ex = executor()
  const shutdown = () => {
    void ex.close().finally(() => process.exit(130))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    const sup = new Supervisor({ store, executor: ex, dataDir, actor: 'cli', log: (_id, line) => say(line) })
    const started = sup.start(typeof id === 'string' ? id : id(sup), { wait: !values['no-wait'] })
    if (!started.ok) return fail(started.error)
    summary(await started.done)
  } finally {
    await ex.close()
  }
}

const commands: Record<string, () => Promise<void> | void> = {
  async run() {
    if (values.repo === undefined) fail('需要 --repo <仓库路径>')
    await run(sup => {
      const created = sup.create({ repo: values.repo!, workflow: values.workflow!, request: positionals.slice(1).join(' ') })
      if (!created.ok) return fail(created.error)
      const meta = store.meta(created.id)
      say(`任务 ${created.id}：工作流 ${store.get(created.id)!.workflow.name}，分支 ${meta.branch}，worktree ${meta.worktree}`)
      return created.id
    })
  },
  async resume() {
    await run(taskOf(positionals[1]).id)
  },
  async retry() {
    const t = taskOf(positionals[1])
    const step = store.dispatch(t.id, { kind: 'retry' }, Date.now(), 'cli')
    if (!step.accepted) fail(step.reason!)
    await run(t.id)
  },
  answer() {
    const t = taskOf(positionals[1])
    const text = positionals.slice(2).join(' ')
    if (t.question === undefined) fail(`任务 ${t.id} 没有待回答的问题`)
    const step = store.dispatch(t.id, { kind: 'answered', questionId: t.question!.id, text }, Date.now(), 'cli')
    if (!step.accepted) fail(step.reason!)
    say(`已回答 ${t.question!.id}。${t.question!.source === 'loop' ? `如果 runner 已经退出，用 npm run eos -- resume ${t.id} 继续。` : '运行中的 agent 会接着做。'}`)
  },
  status() {
    if (positionals[1] !== undefined) return summary(taskOf(positionals[1]))
    const tasks = store.list()
    if (tasks.length === 0) return say('还没有任务')
    for (const s of tasks) say(`${s.id}  ${STATUS[s.status].padEnd(4)}  ${s.workflow.padEnd(8)}  ${s.request.slice(0, 50)}`)
  },
  log() {
    const t = taskOf(positionals[1])
    for (const e of t.log) {
      const time = new Date(e.at).toISOString().slice(11, 19)
      if (e.type === 'call') {
        say(`\n── ${time} [${e.node}${e.round === undefined ? '' : ` 第 ${e.round} 轮`}] ${e.role} · ${e.purpose} · ${(e.ms / 1000).toFixed(1)}s · ${e.model ?? ''}`)
        say(`>>> 提示词\n${e.prompt}\n<<< 回复\n${e.reply}`)
      } else if (e.type === 'question') say(`\n── ${time} 提问（${e.question.source}）：${e.question.text}`)
      else if (e.type === 'answer') say(`\n── ${time} 回答 ${e.questionId}：${e.text}`)
      else if (e.type === 'check') say(`\n── ${time} [${e.node}${e.round === undefined ? '' : ` 第 ${e.round} 轮`}] 检查 · ${(e.ms / 1000).toFixed(1)}s\n${e.results.map(r => `${r.passed ? '✓' : '✗'} ${describeCheck(r.check)}${r.passed || r.detail === '' ? '' : `\n${r.detail}`}`).join('\n')}`)
      else say(`\n── ${time} ${e.node === undefined ? '' : `[${e.node}] `}${e.text}`)
    }
    say(`\n${formatReport(report(t))}`)
  },
  abort() {
    const t = taskOf(positionals[1])
    const step = store.dispatch(t.id, { kind: 'abort' }, Date.now(), 'cli')
    say(step.accepted ? `任务 ${t.id} 已中止` : step.reason!)
  },
  async web() {
    const port = Number(values.port)
    const ex = executor()
    const sup = new Supervisor({ store, executor: ex, dataDir, actor: 'web', log: (id, line) => say(`[${id}] ${line}`) })
    const server = createWebServer({ store, supervisor: sup, replay: ex, staticDir: join(import.meta.dirname, '..', 'web', 'dist') })
    await new Promise<void>(r => server.listen(port, '127.0.0.1', r))
    say(`Eos Web：http://127.0.0.1:${port}（数据目录 ${dataDir}，Ctrl+C 退出）`)
    const resumed = sup.resumeAll()
    if (resumed.length > 0) say(`接着运行上次没跑完的任务：${resumed.join('、')}`)
    const shutdown = () => {
      server.close()
      void ex.close().finally(() => process.exit(130))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await new Promise(() => {})
  },
  workflows() {
    for (const name of builtinTemplates()) {
      const { workflow } = loadWorkflow(name)
      say(`${name}：${workflow.description ?? ''}`)
    }
  },
}

const command = positionals[0]
if (values.help || command === undefined || commands[command] === undefined) {
  say(HELP)
  process.exit(command === undefined || values.help ? 0 : 1)
}
await commands[command]!()
store.close()
