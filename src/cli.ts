// eos 命令行：创建任务、运行、续跑、回答、查看。数据目录默认 ~/.eos，可用 --data 或 EOS_HOME 指定。
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { describePosition } from './engine/machine.ts'
import { formatReport, report } from './engine/report.ts'
import type { Task } from './engine/types.ts'
import { DshExecutor } from './executor/dsh.ts'
import { commitAll, contextFor, createWorktree, diffStat } from './runner/git.ts'
import { acquire } from './runner/lock.ts'
import { runTask } from './runner/runner.ts'
import { Store } from './store/store.ts'
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

选项：--data <目录>（默认 $EOS_HOME 或 ~/.eos）  --no-wait（需要用户回答时直接退出）`

const STATUS: Record<Task['status'], string> = { running: '运行中', waiting_user: '等待回答', done: '已完成', failed: '失败', aborted: '已中止' }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: 'string' }, workflow: { type: 'string', default: 'feature' }, data: { type: 'string' }, 'no-wait': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' } },
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

const withLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const lock = acquire(join(dataDir, 'locks'), id)
  if ('heldBy' in lock) return fail(`任务 ${id} 正在被进程 ${lock.heldBy} 运行`)
  try {
    return await fn()
  } finally {
    lock.release()
  }
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

const run = async (id: string) => {
  const executor = new DshExecutor({ dshHome: join(dataDir, 'dsh'), dshBin: dshBin() })
  const shutdown = () => {
    void executor.close().finally(() => process.exit(130))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    const task = await withLock(id, () => runTask(id, {
      store, executor, wait: !values['no-wait'], log: say,
      afterWrite: (t, call) => {
        const sha = commitAll(store.meta(t.id).worktree, `eos: ${call.node} ${call.purpose} (${call.id})`)
        if (sha !== undefined) say(`  已提交 ${sha}`)
      },
    }))
    summary(task)
  } finally {
    await executor.close()
  }
}

const newId = () => `t${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}${Math.random().toString(36).slice(2, 5)}`

const commands: Record<string, () => Promise<void> | void> = {
  async run() {
    const request = positionals.slice(1).join(' ').trim()
    if (request === '') fail('需要写明需求')
    if (values.repo === undefined) fail('需要 --repo <仓库路径>')
    const { workflow, source } = (() => {
      try {
        return loadWorkflow(values.workflow!)
      } catch (e) {
        return fail((e as Error).message)
      }
    })()
    const id = newId()
    const w = createWorktree(values.repo!, dataDir, id)
    store.create({ id, request, context: contextFor(w), workflow, workflowSource: source, meta: w }, Date.now())
    say(`任务 ${id}：工作流 ${workflow.name}，分支 ${w.branch}，worktree ${w.worktree}`)
    await run(id)
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
      else say(`\n── ${time} ${e.node === undefined ? '' : `[${e.node}] `}${e.text}`)
    }
    say(`\n${formatReport(report(t))}`)
  },
  abort() {
    const t = taskOf(positionals[1])
    const step = store.dispatch(t.id, { kind: 'abort' }, Date.now(), 'cli')
    say(step.accepted ? `任务 ${t.id} 已中止` : step.reason!)
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
