// eos 命令行：创建任务、运行、续跑、回答、查看。数据目录默认 ~/.eos，可用 --data 或 EOS_HOME 指定。
import { describeCheck } from './engine/checks.ts'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { agentNodes, describePosition } from './engine/machine.ts'
import type { NodeId } from './workflow/types.ts'
import { formatMetrics, taskMetrics } from './engine/metrics.ts'
import { formatReport, report } from './engine/report.ts'
import type { Task } from './engine/types.ts'
import { Executors, healthOf } from './executor/registry.ts'
import type { ExecutorContext } from './executor/types.ts'
import { takeMasterKey } from './credentials/key.ts'
import { resolveModelKey, takeModelKeyEnv, type ModelKey } from './credentials/model-key.ts'
import { knownSecrets, redacting, redactText } from './credentials/redact.ts'
import { Credentials } from './credentials/store.ts'
import { AGENT_USER_ENV, resolveCheckUser } from './runner/check-user.ts'
import { evaluate, formatItems, gather } from './runner/doctor.ts'
import { appendLog, processLogPath, taskLogPath } from './runner/logs.ts'
import { holder } from './runner/lock.ts'
import { diffStat } from './runner/git.ts'
import { Supervisor } from './runner/supervisor.ts'
import { Store } from './store/store.ts'
import { createWebServer, listenPlan, parsePublicUrl } from './web/server.ts'
import { WebChats } from './web/chat.ts'
import { Conventions } from './conventions/conventions.ts'
import { generate } from './improve/generate.ts'
import { KIND_NAMES, Proposals, STATUS_NAMES } from './improve/proposals.ts'
import { CHAT_HELP, chatCommand } from './chat/cli.ts'
import { ChatStore } from './chat/store.ts'
import { committedChanges } from './runner/git.ts'

const HELP = `用法：
  eos run --repo <仓库路径或 GitHub 地址> [--workflow standard] "<需求>"   创建任务并运行
  eos resume <任务>                                       续跑（进程中断后）
  eos retry <任务>                                        重试失败的任务
  eos answer <任务> "<回答>"                              回答 agent 的提问或对话尽头的问题
  eos gates                                               列出停在卡点上、等人验收的任务
  eos correct <任务> --node <节点> "<改正或补充>"          已完成的任务：交给这个 agent 节点在原来的会话里修改，改完重跑检查
  eos accept <任务> ["<备注>"]                             验收通过
  eos send-back <任务> "<意见>"                            验收打回：交回被验收的节点按意见修改，改完回到卡点
  eos status [任务]                                       列出任务，或查看一个任务
  eos log <任务>                                          完整对话记录与耗时、token 统计
  eos abort <任务>                                        中止任务
  eos workflows                                           列出内置工作流
  eos doctor                                              检查运行环境（Node、git、数据目录，各执行器的安装、沙箱和 API key）
  eos web [--port 4317] [--host 127.0.0.1]                打开 Web 界面（任务列表与 trace 详情）
  eos improve [--workflow standard] [--tasks <id,…>]      从已结束的任务归纳证据，生成改进提案（待审批）
  eos proposals                                           列出改进提案
  eos approve <提案号> ["<备注>"]                          批准：写成约定的新版本
  eos reject <提案号> "<理由>"                             拒绝
${CHAT_HELP}

选项：--data <目录>（默认 $EOS_HOME 或 ~/.eos）  --no-wait（需要用户回答时直接退出）
web：--host 是监听地址（容器里用 0.0.0.0）；通过别的地址访问时（端口映射、反向代理）设 EOS_PUBLIC_URL，例如 https://eos.example.com。没有登录，不要直接暴露到公网。
run、resume、retry、improve、web 启动前会做同样的环境检查：有 ✗ 不启动，只有 ⚠ 时提示后照常启动。`

const STATUS: Record<Task['status'], string> = { running: '运行中', waiting_user: '等待回答', waiting_accept: '等待验收', done: '已完成', failed: '失败', aborted: '已中止' }

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string' },
    workflow: { type: 'string', default: 'standard' },
    data: { type: 'string' },
    'no-wait': { type: 'boolean', default: false },
    node: { type: 'string' },
    port: { type: 'string', default: '4317' },
    host: { type: 'string', default: '127.0.0.1' },
    help: { type: 'boolean', short: 'h' },
    tasks: { type: 'string' },
    'allow-permissions': { type: 'string' },
    note: { type: 'string' },
  },
})

// 主密钥最先读出并从 process.env 删掉：之后起的任何子进程（dsh、git、检查命令）都继承不到它。
const masterKey = takeMasterKey(process.env)
// 环境变量里的模型 key 也一样：读出后删掉，只交给 dsh 进程，git 和检查命令都拿不到。
const envModelKey = takeModelKeyEnv(process.env)
const dataDir = resolve(values.data ?? process.env.EOS_HOME ?? join(homedir(), '.eos'))
const dbPath = join(dataDir, 'eos.db')
const openCredentials = () => new Credentials(dbPath, masterKey.kind === 'ok' ? masterKey.key : undefined)
/**
 * 启动时的模型 key（给启动检查和 doctor 看）。凭据存储先于环境变量；数据库还不存在时（第一次运行）凭据存储一定是空的，不为此建数据目录。
 * 数据库打不开（损坏、没有权限）时记成读不出来，由检查项报出，而不是直接崩溃。
 */
const startupModelKey = ((): ModelKey => {
  if (!existsSync(dbPath)) return resolveModelKey(undefined, envModelKey)
  let c: Credentials | undefined
  try {
    c = openCredentials()
    return resolveModelKey(c, envModelKey)
  } catch (e) {
    return { source: 'error', error: `打不开凭据存储（${dbPath}）：${(e as Error).message}` }
  } finally {
    c?.close()
  }
})()
const say = (s: string): void => void process.stdout.write(`${s}\n`)
const fail = (s: string): never => {
  process.stderr.write(`${s}\n`)
  process.exit(1)
}

// 启动检查在打开数据库之前做：数据目录不可写时也能给出看得懂的说明。
const ROOT = join(import.meta.dirname, '..')
/** 会调用模型或运行任务的命令：启动前先检查环境，不通过就不启动。 */
const NEEDS_ENV = new Set(['run', 'resume', 'retry', 'correct', 'improve', 'web'])
/** 检查命令用的系统用户（部署镜像里设置 EOS_CHECK_USER）。设置错了由启动检查拦下。 */
const checkUser = resolveCheckUser(process.env)
/** dsh 和 agent 的用户（部署镜像里设置 EOS_AGENT_USER，由 dsh 的入口切换过去）。设置错了由启动检查拦下。 */
const agentUser = resolveCheckUser(process.env, undefined, AGENT_USER_ENV)
/** 交给执行器的环境。modelKey 由调用方给：启动检查看启动时的状态，运行时每次重新读凭据存储。 */
const executorContext = (modelKey: ExecutorContext['modelKey']): ExecutorContext => ({
  root: ROOT,
  dataDir,
  env: process.env,
  modelKey,
  ...(agentUser.kind === 'ok' ? { agentUser: agentUser.user } : {}),
})
const startupChecks = () => evaluate(gather({ root: ROOT, dataDir, executors: healthOf(executorContext(() => startupModelKey)), masterKey, checkUser, agentUser }))
if (positionals[0] === 'doctor' && !values.help) {
  const items = startupChecks()
  say(`Eos 环境检查（数据目录 ${dataDir}）\n${formatItems(items)}`)
  // ⚠ 只是提示，有 ✗ 时退出码才不为 0。
  process.exit(items.some(i => i.status === 'fail') ? 1 : 0)
}
// chat 只有新建和接着说会调用模型；list、show 只读数据库。
if (!values.help && (NEEDS_ENV.has(positionals[0] ?? '') || (positionals[0] === 'chat' && ['new', 'send'].includes(positionals[1] ?? '')))) {
  const items = startupChecks()
  const bad = items.filter(i => i.status === 'fail')
  if (bad.length > 0) fail(`启动前检查没有通过，没有启动：\n${formatItems(bad)}\n\n全部检查：npm run eos -- doctor`)
  const warned = items.filter(i => i.status === 'warn' && i.doctorOnly !== true)
  if (warned.length > 0) process.stderr.write(`启动前检查有提示（照常启动）：\n${formatItems(warned)}\n\n`)
}
mkdirSync(dataDir, { recursive: true })
const store = new Store(dbPath)
const credentials = openCredentials()
/** 遮蔽已知凭据值：日志、检查输出、agent 的回复和 trace 写下来之前都经过它。 */
const redact = (() => {
  // 主密钥两种写法都算：部署方可能省略了末尾的 =，泄露出来的是原文。
  const master = masterKey.kind === 'ok' ? masterKey.key.key.toString('base64') : undefined
  const extra = [...(envModelKey === undefined ? [] : [envModelKey]), ...(master === undefined ? [] : [master, master.replace(/=+$/, '')])]
  const secrets = knownSecrets(credentials, extra, Date.now, e => process.stderr.write(`读不到凭据列表，遮蔽暂时沿用上次的凭据值：${(e as Error).message}\n`))
  return (text: string) => redactText(text, secrets())
})()

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
  if (t.failure !== undefined) say(`失败原因\n${t.failure}${t.failure.includes('eos -- retry') ? '' : `\n重试：npm run eos -- retry ${t.id}`}\n日志：${taskLogPath(dataDir, t.id)}`)
  showQuestion(t)
  if (t.status === 'waiting_accept' && t.gate !== undefined) {
    const g = t.workflow.nodes.find(n => n.id === t.gate!.node)
    const target = g?.kind === 'gate' ? g.with : undefined
    const meta = store.meta(t.id)
    say(`\n待验收：「${target}」的产出\n${target === undefined ? '' : (t.outputs[target] ?? '（没有产出）')}\n\n改动（分支 ${meta.branch}，worktree ${meta.worktree}）\n${diffStat(meta)}`)
    say(`通过：npm run eos -- accept ${t.id} ["<备注>"]\n打回：npm run eos -- send-back ${t.id} "<意见>"`)
  }
  if (t.status === 'done') {
    const meta = store.meta(t.id)
    say(`\n分支 ${meta.branch}，worktree ${meta.worktree}\n${diffStat(meta)}`)
  }
  say(`\n${formatReport(report(t))}`)
}

/** 人在卡点上给出结论：验收的是任务现在等着的那一次。 */
const decide = (pass: boolean) => {
  const t = taskOf(positionals[1])
  const comment = positionals.slice(2).join(' ')
  if (t.status !== 'waiting_accept' || t.gate === undefined) fail(`任务 ${t.id} 没有在等验收（${STATUS[t.status]} · ${describePosition(t)}）`)
  const step = store.dispatch(t.id, { kind: 'decided', gate: t.gate!.node, round: t.gate!.round, pass, comment }, Date.now(), 'cli')
  if (!step.accepted) fail(step.reason!)
  const alive = holder(join(dataDir, 'locks'), t.id) !== undefined
  say(`「${t.gate!.node}」第 ${t.gate!.round} 次验收：${pass ? '通过' : '打回'}。${alive ? '运行中的 runner 会接着做。' : `runner 没有在运行，用 npm run eos -- resume ${t.id} 继续。`}`)
}

const proposalId = (): number => (/^\d{1,15}$/.test(positionals[1] ?? '') ? Number(positionals[1]) : fail('需要提案号（数字），见 eos proposals'))

/** 注册表里的执行器：角色按 executor 选，用到时才建。模型 key 每次取都重新读凭据存储（Web 上换了 key 之后起的进程就用新的）。 */
const executors = () => new Executors(executorContext(() => resolveModelKey(credentials, envModelKey)))
const executor = () => redacting(executors(), redact)
/** 交给 Supervisor 的执行器：遮蔽过的执行器，以及核对角色写的执行器有没有登记。 */
const supervised = () => {
  const registry = executors()
  return { executor: redacting(registry, redact), unknownExecutor: (name: string) => registry.unknown(name) }
}

/** 在本进程里运行一个任务直到结束（或在 --no-wait 时停在需要用户回答的地方）。 */
const run = async (id: string | ((sup: Supervisor) => Promise<string>)) => {
  const { executor: ex, unknownExecutor } = supervised()
  const shutdown = () => {
    void ex.close().finally(() => process.exit(130))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    const sup = new Supervisor({
      store,
      executor: ex,
      unknownExecutor,
      dataDir,
      credentials,
      actor: 'cli',
      log: (_id, line) => say(line),
      redact,
      ...(checkUser.kind === 'ok' ? { checkUser: checkUser.user } : {}),
      ...(agentUser.kind === 'ok' ? { agentUser: agentUser.user } : {}),
    })
    const started = sup.start(typeof id === 'string' ? id : await id(sup), { wait: !values['no-wait'] })
    if (!started.ok) return fail(started.error)
    summary(await started.done)
  } finally {
    await ex.close()
  }
}

const commands: Record<string, () => Promise<void> | void> = {
  async run() {
    if (values.repo === undefined) fail('需要 --repo <仓库路径或 https://github.com/<owner>/<repo>>')
    await run(async sup => {
      const created = await sup.create({ repo: values.repo!, workflow: values.workflow!, request: positionals.slice(1).join(' ') })
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
  gates() {
    const waiting = store.list().filter(s => s.status === 'waiting_accept')
    if (waiting.length === 0) return say('没有等验收的任务')
    for (const s of waiting) {
      const t = store.get(s.id)!
      say(`${t.id}  ${describePosition(t)}  ${t.request.split('\n')[0]!.slice(0, 50)}`)
    }
    say(`\n查看产出和改动：npm run eos -- status <任务>；通过：npm run eos -- accept <任务>；打回：npm run eos -- send-back <任务> "<意见>"`)
  },
  accept() {
    decide(true)
  },
  'send-back'() {
    decide(false)
  },
  /** 已完成的任务上提交一条改正或补充，然后在本进程里接着跑（和 retry 一样）。 */
  async correct() {
    const t = taskOf(positionals[1])
    if (values.node === undefined) fail(`需要 --node <节点>，可以交给：${agentNodes(t.workflow).join('、')}`)
    const step = store.dispatch(t.id, { kind: 'corrected', node: values.node as NodeId, text: positionals.slice(2).join(' ') }, Date.now(), 'cli')
    if (!step.accepted) fail(step.reason!)
    say(`第 ${step.task.correction!.round} 次修正：交给「${values.node}」`)
    await run(t.id)
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
      else if (e.type === 'check')
        say(
          `\n── ${time} [${e.node}${e.round === undefined ? '' : ` 第 ${e.round} 轮`}] 检查 · ${(e.ms / 1000).toFixed(1)}s\n${e.results.map(r => `${r.passed ? '✓' : '✗'} ${describeCheck(r.check)}${r.passed || r.detail === '' ? '' : `\n${r.detail}`}`).join('\n')}`,
        )
      else if (e.type === 'decision') say(`\n── ${time} [${e.node} 第 ${e.round} 次验收] ${e.by === 'human' ? '人' : e.by}：${e.pass ? '通过' : '打回'}${e.comment === '' ? '' : `\n${e.comment}`}`)
      else say(`\n── ${time} ${e.node === undefined ? '' : `[${e.node}] `}${e.text}`)
    }
    say(`\n${formatReport(report(t))}`)
    say(`\n各阶段耗时\n${formatMetrics(taskMetrics(t, Date.now(), store.createdAt(t.id)))}`)
  },
  abort() {
    const t = taskOf(positionals[1])
    const step = store.dispatch(t.id, { kind: 'abort' }, Date.now(), 'cli')
    say(step.accepted ? `任务 ${t.id} 已中止` : step.reason!)
  },
  async improve() {
    if (positionals.length > 1) fail('用法：eos improve [--workflow standard] [--tasks <id,…>]')
    const ex = executor()
    const conventions = new Conventions(store)
    conventions.seed(Date.now())
    const tasks = values.tasks
      ?.split(',')
      .map(x => x.trim())
      .filter(x => x !== '')
    let r
    try {
      r = await generate({ store, conventions, executor: ex, dataDir, workflow: values.workflow!, ...(tasks === undefined ? {} : { tasks }), actor: 'cli', now: Date.now, log: say })
    } finally {
      await ex.close()
    }
    if (!r.ok) return fail(r.call === undefined ? r.error : `${r.error}\n回复的开头：\n${r.call.reply.slice(0, 500)}`)
    {
      if (r.skipped !== undefined) return say(r.skipped)
      for (const p of r.created) say(`\n提案 #${p.id}：${KIND_NAMES[p.target.kind]}「${p.target.name}」第 ${p.baseVersion} 版 → 新版本\n理由：${p.rationale}\n证据：${p.evidence.join('、')}`)
      say(r.created.length === 0 ? '\n没有生成提案' : `\n共 ${r.created.length} 条待审批：npm run eos -- approve <提案号>，或在网页上审批`)
    }
  },
  proposals() {
    const all = store.proposals()
    if (all.length === 0) return say('还没有改进提案')
    for (const p of all) say(`#${p.id}  ${STATUS_NAMES[p.status]}  ${KIND_NAMES[p.target.kind]}「${p.target.name}」第 ${p.baseVersion} 版  ${p.rationale.split('\n')[0]!.slice(0, 50)}`)
  },
  approve() {
    const r = new Proposals(store, new Conventions(store)).approve(proposalId(), Date.now(), 'cli', positionals.slice(2).join(' '))
    if (!r.ok) return fail(r.error)
    say(`提案 #${r.row.id} 已批准：${KIND_NAMES[r.row.target.kind]}「${r.row.target.name}」现在是第 ${r.row.events.at(-1)!.version} 版`)
  },
  reject() {
    const r = new Proposals(store, new Conventions(store)).reject(proposalId(), Date.now(), 'cli', positionals.slice(2).join(' '))
    if (!r.ok) return fail(r.error)
    say(`提案 #${r.row.id} 已拒绝`)
  },
  async web() {
    const port = Number(values.port)
    const publicUrl = process.env.EOS_PUBLIC_URL === undefined || process.env.EOS_PUBLIC_URL === '' ? undefined : parsePublicUrl(process.env.EOS_PUBLIC_URL)
    if (typeof publicUrl === 'string') return fail(publicUrl)
    const { executor: ex, unknownExecutor } = supervised()
    // Web 服务进程的输出也写进 logs/eos.log：服务器上没人盯着终端。
    const processLog = processLogPath(dataDir)
    const note = (raw: string) => {
      const line = redact(raw)
      appendLog(processLog, line)
      say(line)
    }
    const sup = new Supervisor({
      store,
      executor: ex,
      unknownExecutor,
      dataDir,
      credentials,
      actor: 'web',
      log: (id, line) => note(`[${id}] ${line}`),
      redact,
      ...(checkUser.kind === 'ok' ? { checkUser: checkUser.user } : {}),
      ...(agentUser.kind === 'ok' ? { agentUser: agentUser.user } : {}),
    })
    const server = createWebServer({
      store,
      supervisor: sup,
      replay: ex,
      staticDir: join(import.meta.dirname, '..', 'web', 'dist'),
      credentials,
      improve: { executor: ex, dataDir },
      chat: new WebChats({ store, conventions: sup.conventions, executor: ex, dataDir, redact, changes: id => committedChanges(store.meta(id)), now: Date.now }),
      ...(publicUrl === undefined ? {} : { publicUrl }),
    })
    const plan = listenPlan(values.host, port, publicUrl)
    if (typeof plan === 'string') return fail(plan)
    await new Promise<void>(r => {
      const failed = (e: NodeJS.ErrnoException) => {
        const line = `Web 服务没能监听 ${values.host}:${port}：${e.code ?? e.message}`
        appendLog(processLog, line)
        fail(line)
      }
      server.once('error', failed).listen(port, values.host, () => {
        server.off('error', failed)
        r()
      })
    })
    if (plan.exposed)
      note(
        `注意：监听 ${values.host}，能连到这台机器 ${port} 端口的人都能用 Eos（没有登录）。浏览器只能通过 ${publicUrl === undefined ? `localhost:${port} 访问；用别的地址或端口访问时要设 EOS_PUBLIC_URL` : `localhost:${port} 或 ${publicUrl.origin} 访问`}`,
      )
    note(`Eos Web：${plan.url}（监听 ${values.host}:${port}，数据目录 ${dataDir}，日志 ${processLog}，Ctrl+C 退出）`)
    const resumed = sup.resumeAll()
    if (resumed.length > 0) note(`接着运行上次没跑完的任务：${resumed.join('、')}`)
    const shutdown = () => {
      // 凭据存储最后关：执行器关闭期间，任务还可能要取模型 key（新起 dsh）、写遮蔽过的日志。
      server.close()
      void ex.close().finally(() => {
        credentials.close()
        process.exit(130)
      })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    await new Promise(() => {})
  },
  async chat() {
    const conventions = new Conventions(store)
    conventions.seed(Date.now())
    await chatCommand(positionals.slice(1), {
      ...(values['allow-permissions'] === undefined ? {} : { confirm: values['allow-permissions'] }),
      ...(values.note === undefined ? {} : { note: values.note }),
      chats: new ChatStore(store.db),
      data: { store, conventions, changes: id => committedChanges(store.meta(id)), now: Date.now },
      conventions,
      executor,
      dataDir,
      redact,
      now: Date.now,
      say,
      fail,
    })
  },
  workflows() {
    const conventions = new Conventions(store)
    conventions.seed(Date.now())
    for (const w of conventions.list('workflow')) say(`${w.name}（第 ${w.version} 版）：${w.description ?? ''}`)
    const docs = conventions.list('doc')
    if (docs.length > 0) say(`\n约定文档：${docs.map(d => `${d.name}（第 ${d.version} 版）`).join('、')}`)
  },
}

const command = positionals[0]
if (values.help || command === undefined || commands[command] === undefined) {
  say(HELP)
  process.exit(command === undefined || values.help ? 0 : 1)
}
await commands[command]!()
credentials.close()
store.close()
