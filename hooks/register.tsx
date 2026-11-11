// devbench 引擎层：把纯逻辑（core/）接到 Claude Code 上。
// 负责：命令、子 agent、执行阶段、记录用量、写产物、面板、受保护命令拦截。
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DevbenchConfig, StageId, Task, Tokens } from '../types'
import { compilePatterns, protectedMatch } from './core/guard'
import {
  STATUS_ICON,
  STATUS_LABEL,
  TASK_LABEL,
  flowMetrics,
  formatDuration,
  formatTokens,
  inputTotal,
} from './core/metrics'
import {
  STAGES,
  abandonedRun,
  emptyRun,
  isCurrentRun,
  isFinalAgentStatus,
  isTerminal,
  reduce,
  stageDef,
  startTask,
} from './core/pipeline'
import type { Action, Event, MachineConfig, RunRef } from './core/pipeline'
import {
  DEVELOPER_PROMPT,
  PLANNER_PROMPT,
  REVIEWER_PROMPT,
  devTask,
  reviewTask,
  specTask,
} from './core/prompts'
import { parseVerdict, verdictFeedback } from './core/verdict'

type Engine = EngineInterface

/**
 * 引擎能力的闭包集合。校验器不允许把 $ 本身传来传去，
 * 所以在 session.start 里用 $.noun.method 组装一次，后台流程都通过它调用。
 */
type Io = {
  now: Engine['clock']['now']
  after: Engine['clock']['after']
  read: (path: string) => Promise<string>
  write: Engine['fs']['write']
  exists: Engine['fs']['exists']
  list: Engine['fs']['list']
  run: Engine['process']['run']
  spawnProcess: Engine['process']['spawn']
  spawn: Engine['agent']['spawn']
  stopAgent: (id: string) => Promise<unknown>
  fillPrompt: (text: string) => ReturnType<Engine['prompt']['fill']>
  toast: Engine['ui']['toast']
  notify: Engine['ui']['notify']
  status: Engine['ui']['status']
  open: Engine['ui']['open']
  tasks: () => Promise<Task[]>
  setTasks: (fn: (list: Task[]) => Task[]) => Promise<unknown>
  selected: () => Promise<string | null>
  select: (id: string) => Promise<unknown>
}

const PLUGIN = 'devbench'
const PANE = 'devbench'
const DATA_DIR = '.devbench'
const LIMIT = 1_000_000

const tasksAtom = atom({ plugin: 'devbench', key: 'tasks' } as const, [] as Task[], {
  shape: 'tasks-3',
})
const selectedAtom = atom({ plugin: 'devbench', key: 'selected' } as const, null as string | null)

const AGENTS = {
  planner: `${PLUGIN}:planner`,
  developer: `${PLUGIN}:developer`,
  reviewer: `${PLUGIN}:reviewer`,
} as const

// ---------- 会话级上下文（模块重载后由 session.start 重建） ----------

let io: Io | undefined
let root = ''
/** 先于 agentId 落盘到达的 turn.complete，按 agentId 暂存。 */
const early = new Map<string, Completion>()

/** 一次阶段运行里的命令（测试、合并、部署、开发前的依赖安装）。stopped 之后不再起新命令、不再回报结果。 */
type CommandRun = RunRef & { stopped: boolean; kill?: () => void }
/** 每个任务最近开始的那次阶段运行，中止或重试时由 stopRun 停掉它的命令；下一次运行开始时被替换。 */
const commands = new Map<string, CommandRun>()

type Completion = { answer: string; ok: boolean; reason: string; final: boolean; durationMs: number; tokens?: Tokens; model?: string }

const join = (...parts: string[]): string => parts.join('/').replace(/\/+/g, '/')
const taskFile = (t: Task): string => join(t.dir, 'task.json')
const artifact = (t: Task, name: string): string => join(t.dir, 'artifacts', name)
const clip = (text: string, max = LIMIT): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`
const tail = (text: string, max = 4000): string => (text.length <= max ? text : `…${text.slice(-max)}`)

// ---------- 配置 ----------

type Resolved = {
  test: string[] | null
  setup: string[] | null
  deploy: string[] | null
  machine: MachineConfig
  models: Required<NonNullable<DevbenchConfig['models']>>
  patterns: RegExp[]
}

const readJson = async (io: Io, path: string): Promise<Record<string, unknown> | undefined> => {
  try {
    return JSON.parse(await io.read(path)) as Record<string, unknown>
  } catch {
    return undefined
  }
}

const loadConfig = async (io: Io): Promise<Resolved> => {
  const raw = ((await readJson(io, join(root, '.devbench.json'))) ?? {}) as DevbenchConfig & {
    setupCommand?: string[] | null
  }
  const pkg = await readJson(io, join(root, 'package.json'))
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>
  const hasNpmTest = typeof scripts.test === 'string' && !scripts.test.includes('no test specified')
  const test = raw.testCommand !== undefined ? raw.testCommand : hasNpmTest ? ['npm', 'test'] : null

  let setup: string[] | null = raw.setupCommand ?? null
  if (raw.setupCommand === undefined && pkg !== undefined) {
    if (await io.exists(join(root, 'pnpm-lock.yaml'))) setup = ['pnpm', 'install', '--frozen-lockfile']
    else if (await io.exists(join(root, 'yarn.lock'))) setup = ['yarn', 'install', '--frozen-lockfile']
    else if (await io.exists(join(root, 'package-lock.json'))) setup = ['npm', 'ci']
    else setup = ['npm', 'install']
  }
  const deploy = raw.deployCommand ?? null
  return {
    test,
    setup,
    deploy,
    machine: { maxRework: raw.maxRework ?? 2, hasTest: test !== null, hasDeploy: deploy !== null },
    models: {
      planner: raw.models?.planner ?? 'inherit',
      developer: raw.models?.developer ?? 'inherit',
      reviewer: raw.models?.reviewer ?? 'sonnet',
    },
    patterns: compilePatterns(raw.protectedCommands ?? []),
  }
}

// ---------- 持久化：任务目录是唯一事实来源，$.state 是面板的缓存 ----------

const save = async (io: Io, task: Task): Promise<void> => {
  await io.setTasks(list =>
    list.some(t => t.id === task.id) ? list.map(t => (t.id === task.id ? task : t)) : [...list, task],
  )
  await io.write(taskFile(task), JSON.stringify(task, null, 2))
}

/**
 * 旧版本写的 task.json：没有 seq 的用 attempts 补上，否则运行中的那次再也认领不到结果；
 * 没有 runs 的补空数组，那之前的运行只剩累计值（时间线会注明）。
 */
const migrate = (task: Task): Task => ({
  ...task,
  stages: Object.fromEntries(
    STAGES.map(s => {
      const run = task.stages[s.id]
      return [s.id, { ...run, seq: run.seq ?? run.attempts, runs: run.runs ?? [] }]
    }),
  ) as Task['stages'],
})

const loadTasks = async (io: Io): Promise<Task[]> => {
  const dir = join(root, DATA_DIR, 'tasks')
  if (!(await io.exists(dir))) return []
  const entries = await io.list(dir)
  const tasks: Task[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const task = (await readJson(io, join(dir, entry.name, 'task.json'))) as Task | undefined
    if (task?.id !== undefined) tasks.push(migrate(task))
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt)
}

const findTask = async (io: Io, id?: string): Promise<Task | undefined> => {
  const list = await io.tasks()
  if (id !== undefined && id !== '') return list.find(t => t.id === id || t.id.endsWith(id))
  const selected = await io.selected()
  const chosen = list.find(t => t.id === selected)
  if (chosen !== undefined && !isTerminal(chosen)) return chosen
  return [...list].reverse().find(t => !isTerminal(t)) ?? chosen ?? list.at(-1)
}

const git = (io: Io, args: string[], cwd = root, timeoutMs = 60_000) =>
  io.run(['git', ...args], { cwd, timeoutMs })

// ---------- 状态推进 ----------

/** 每个任务一条串行队列：读-改-写之间有 await，并发事件（如连按两次批准）会互相覆盖。 */
const queues = new Map<string, Promise<unknown>>()

const serial = <T,>(taskId: string, fn: () => Promise<T>): Promise<T> => {
  const run = (queues.get(taskId) ?? Promise.resolve()).then(fn)
  queues.set(taskId, run.catch(() => undefined))
  return run
}

/** 把事件交给状态机，保存结果并执行下一步。同一任务的事件串行处理。 */
const dispatch = (io: Io, taskId: string, event: Event): Promise<Action | undefined> =>
  serial(taskId, () => dispatchNow(io, taskId, event))

const dispatchNow = async (io: Io, taskId: string, event: Event): Promise<Action | undefined> => {
  const task = (await io.tasks()).find(t => t.id === taskId)
  if (task === undefined) return undefined
  const config = await loadConfig(io)
  const { task: next, action } = reduce(task, event, await io.now(), config.machine)
  if (next !== task) await save(io, next)
  const abandoned = abandonedRun(task, next, event)
  // 先停旧的再执行动作：重试会立刻开始新的一次运行。
  if (abandoned !== undefined) await stopRun(io, taskId, abandoned)
  await perform(io, next, action, config)
  return action
}

const stopRun = async (io: Io, taskId: string, run: RunRef & { agentId?: string }): Promise<void> => {
  const command = commands.get(taskId)
  if (command?.stage === run.stage && command.seq === run.seq) {
    command.stopped = true
    command.kill?.()
    commands.delete(taskId)
  }
  if (run.agentId !== undefined) await stopAgent(io, run.agentId)
}

const stopAgent = async (io: Io, id: string): Promise<void> => {
  try {
    const result = await io.stopAgent(id)
    if (typeof result === 'object' && result !== null && 'isError' in result && result.isError === true) {
      io.toast(`未能停止子 agent：${JSON.stringify(result).slice(0, 200)}`)
    }
  } catch (error) {
    io.toast(`未能停止子 agent：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 驳回必须写理由，面板按钮没法输入，就把命令填进输入框让用户补上。 */
const askRejectReason = async (io: Io): Promise<void> => {
  const filled = await io.fillPrompt('/devbench reject ')
  if (!filled.isFilled) io.toast('请输入 /devbench reject <理由> 驳回')
}

const perform = async (io: Io, task: Task, action: Action, config: Resolved): Promise<void> => {
  switch (action.kind) {
    case 'run': {
      const ref = { stage: action.stage, seq: task.stages[action.stage].seq }
      // 放到定时器里跑，避免占用当前钩子的时间预算。
      io.after(0, () => {
        void runStage(io, task.id, ref, config).catch(err =>
          finished(io, task.id, ref, { ok: false, note: `执行出错：${String(err)}`, durationMs: 0 }),
        )
      })
      return
    }
    case 'wait': {
      const text = `「${task.title}」等待批准：${stageDef(action.stage).label}`
      io.toast(text)
      void io.notify(`${text}（/devbench approve 或在面板中批准）`, { title: 'Devbench' })
      await io.open({ id: PANE, title: 'Devbench' })
      return
    }
    case 'done':
      io.toast(`「${task.title}」已完成`)
      void io.notify(`「${task.title}」流水线已完成`, { title: 'Devbench' })
      return
    case 'failed':
      io.toast(`「${task.title}」失败：${action.reason}`)
      void io.notify(`「${task.title}」失败：${action.reason}`, { title: 'Devbench' })
      return
    case 'none':
      return
  }
}

const finished = async (
  io: Io,
  taskId: string,
  run: RunRef,
  r: { ok: boolean; note?: string; durationMs: number; tokens?: Tokens; model?: string },
): Promise<void> => {
  await dispatch(io, taskId, { kind: 'finished', ...run, ...r })
}

type Ran = { exitCode: number; stdout: string; stderr: string }

/** 两路输出各留前 LIMIT 个字符，和产物的截断一致。 */
const keep = (acc: string, text: string): string => (acc.length >= LIMIT ? acc : acc + text)

/**
 * 在这次阶段运行里执行一条命令，可被 stopRun 停掉（离开 for await 就会杀掉子进程）。
 * 运行被停掉时返回 undefined：这次运行已被放弃，调用方不写产物、不回报结果。
 */
const exec = async (io: Io, run: CommandRun, argv: string[], cwd: string, timeoutMs = 600_000): Promise<Ran | undefined> => {
  if (run.stopped) return undefined
  const child = io.spawnProcess({ argv, cwd })
  const kill = () => void child.return({ code: null, signal: null })
  let timedOut = false
  const timer = io.after(timeoutMs, () => {
    timedOut = true
    kill()
  })
  run.kill = kill
  let stdout = ''
  let stderr = ''
  try {
    for await (const piece of child) {
      if (piece.stream === 'stdout') stdout = keep(stdout, piece.text)
      else stderr = keep(stderr, piece.text)
    }
  } catch (err) {
    return run.stopped ? undefined : { exitCode: 1, stdout, stderr: `${stderr}${String(err)}` }
  } finally {
    timer.cancel()
    run.kill = undefined
  }
  if (run.stopped) return undefined
  if (timedOut) return { exitCode: 1, stdout, stderr: `${stderr}\n超过 ${timeoutMs / 1000} 秒未结束，已停止` }
  const end = await child.result
  if (run.stopped) return undefined
  return { exitCode: end.code ?? 1, stdout, stderr: end.signal === null ? stderr : `${stderr}\n被信号 ${end.signal} 结束` }
}

const addArtifact = async (io: Io, task: Task, stage: StageId, name: string, text: string): Promise<Task> => {
  await io.write(artifact(task, name), clip(text))
  // 只把产物名合并进最新状态，不用旧快照覆盖（期间可能已被中止或推进）。
  const latest = (await io.tasks()).find(t => t.id === task.id) ?? task
  const run = latest.stages[stage]
  if (run.artifacts.includes(name)) return latest
  const next = { ...latest, stages: { ...latest.stages, [stage]: { ...run, artifacts: [...run.artifacts, name] } } }
  await save(io, next)
  return next
}

/** 执行某个阶段的这一次运行：agent 阶段只负责启动，结果由 turn.complete 回来；命令阶段在这里跑完。 */
const runStage = async (io: Io, taskId: string, ref: RunRef, config: Resolved): Promise<void> => {
  let task = (await io.tasks()).find(t => t.id === taskId)
  if (task === undefined || !isCurrentRun(task, ref)) return
  const stage = ref.stage
  const startedAt = await io.now()
  const elapsed = async () => (await io.now()) - startedAt
  const run: CommandRun = { ...ref, stopped: false }
  commands.set(taskId, run)

  switch (stage) {
    case 'spec':
      return spawn(io, task, ref, AGENTS.planner, config.models.planner, root, specTask(task.request, task.feedback))

    case 'dev': {
      if (task.stages.dev.attempts === 1 && config.setup !== null) {
        io.status(`devbench：安装依赖 ${config.setup.join(' ')}`)
        const setup = await exec(io, run, config.setup, task.git.worktree)
        io.status(undefined)
        if (setup === undefined) return
        task = await addArtifact(io, task, 'dev', '02-setup.log', `$ ${config.setup.join(' ')}\n${setup.stdout}\n${setup.stderr}`)
        if (setup.exitCode !== 0) {
          return finished(io, taskId, ref, { ok: false, note: `依赖安装失败：\n${tail(setup.stderr || setup.stdout)}`, durationMs: await elapsed() })
        }
      }
      const prompt = devTask({ specPath: artifact(task, '01-spec.md'), worktree: task.git.worktree, feedback: task.feedback })
      return spawn(io, task, ref, AGENTS.developer, config.models.developer, task.git.worktree, prompt)
    }

    case 'test': {
      const argv = config.test ?? []
      io.status(`devbench：运行测试 ${argv.join(' ')}`)
      const result = await exec(io, run, argv, task.git.worktree)
      io.status(undefined)
      if (result === undefined) return
      const log = `$ ${argv.join(' ')}\nexit ${result.exitCode}\n\n${result.stdout}\n${result.stderr}`
      await addArtifact(io, task, 'test', `03-test-${task.stages.test.attempts}.log`, log)
      const ok = result.exitCode === 0
      return finished(io, taskId, ref, {
        ok,
        note: ok ? `exit 0` : `exit ${result.exitCode}\n${tail(`${result.stdout}\n${result.stderr}`)}`,
        durationMs: await elapsed(),
      })
    }

    case 'review': {
      const testRun = task.stages.test
      const prompt = reviewTask({
        specPath: artifact(task, '01-spec.md'),
        diffPath: artifact(task, '02-diff.patch'),
        worktree: task.git.worktree,
        testSummary: testRun.status === 'passed' ? `已通过（${(config.test ?? []).join(' ')}）` : testRun.note,
        feedback: task.feedback,
      })
      return spawn(io, task, ref, AGENTS.reviewer, config.models.reviewer, task.git.worktree, prompt)
    }

    case 'merge': {
      const inRoot = (args: string[]) => exec(io, run, ['git', ...args], root, 60_000)
      const head = await inRoot(['rev-parse', '--abbrev-ref', 'HEAD'])
      const dirty = await inRoot(['status', '--porcelain', '--untracked-files=no'])
      if (head === undefined || dirty === undefined) return
      const lines: string[] = []
      let ok = false
      let note = ''
      if (head.stdout.trim() !== task.git.baseBranch) {
        note = `主仓库当前在 ${head.stdout.trim()}，不是基线分支 ${task.git.baseBranch}，请先切回再重试`
      } else if (dirty.stdout.trim() !== '') {
        note = `主仓库有未提交的改动，请先处理再重试：\n${dirty.stdout}`
      } else {
        const merged = await inRoot(['merge', '--no-ff', '--no-edit', '-m', `Merge ${task.git.branch}: ${task.title}`, task.git.branch])
        if (merged === undefined) return
        lines.push(merged.stdout, merged.stderr)
        ok = merged.exitCode === 0
        if (!ok) {
          await inRoot(['merge', '--abort'])
          note = `合并失败（已 abort）：\n${tail(merged.stderr || merged.stdout)}`
        } else note = `已合并到 ${task.git.baseBranch}`
      }
      if (run.stopped) return
      await addArtifact(io, task, 'merge', '05-merge.log', [note, ...lines].join('\n'))
      return finished(io, taskId, ref, { ok, note, durationMs: await elapsed() })
    }

    case 'deploy': {
      const argv = config.deploy ?? []
      const result = await exec(io, run, argv, root)
      if (result === undefined) return
      await addArtifact(io, task, 'deploy', '06-deploy.log', `$ ${argv.join(' ')}\nexit ${result.exitCode}\n\n${result.stdout}\n${result.stderr}`)
      const ok = result.exitCode === 0
      return finished(io, taskId, ref, {
        ok,
        note: ok ? '部署完成' : `exit ${result.exitCode}\n${tail(result.stderr || result.stdout)}`,
        durationMs: await elapsed(),
      })
    }
  }
}

const spawn = async (
  io: Io,
  task: Task,
  ref: RunRef,
  subagentType: string,
  model: string,
  cwd: string,
  prompt: string,
): Promise<void> => {
  const spawned = await io.spawn({
    subagentType,
    prompt,
    description: `devbench ${stageDef(ref.stage).label}：${task.title}`.slice(0, 80),
    cwd,
    ...(model === 'inherit' ? {} : { model }),
  })
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    return finished(io, task.id, ref, { ok: false, note: `子 agent 未能启动：${spawned.deny ?? '未知原因'}`, durationMs: 0 })
  }
  const agentId = spawned.agentId
  // 和事件同一条队列：spawn 期间这次运行可能已被中止或重试，那样 agentId 不能记到新的运行上。
  const claimed = await serial(task.id, async () => {
    const latest = (await io.tasks()).find(t => t.id === task.id)
    if (latest === undefined || !isCurrentRun(latest, ref)) return false
    const run = latest.stages[ref.stage]
    await save(io, { ...latest, stages: { ...latest.stages, [ref.stage]: { ...run, agentId, model: spawned.model } } })
    return true
  })
  if (!claimed) return stopAgent(io, agentId)
  const done = early.get(agentId)
  if (done !== undefined) {
    early.delete(agentId)
    if (done.final) await onAgentDone(io, task.id, ref, done)
    else await dispatch(io, task.id, { kind: 'progress', ...ref, durationMs: done.durationMs, tokens: done.tokens, model: done.model })
  }
}

/** 子 agent 结束：写产物、整理结论，交给状态机。 */
const onAgentDone = async (io: Io, taskId: string, ref: RunRef, c: Completion): Promise<void> => {
  let task = (await io.tasks()).find(t => t.id === taskId)
  if (task === undefined) return
  const stage = ref.stage
  const usage = { durationMs: c.durationMs, tokens: c.tokens, model: c.model }
  if (!c.ok) return finished(io, taskId, ref, { ok: false, note: `子 agent 未正常结束（${c.reason}）`, ...usage })

  switch (stage) {
    case 'spec': {
      const ok = c.answer.trim() !== ''
      await addArtifact(io, task, 'spec', '01-spec.md', c.answer)
      return finished(io, taskId, ref, { ok, note: ok ? undefined : 'Spec 为空', ...usage })
    }
    case 'dev': {
      const n = task.stages.dev.attempts
      task = await addArtifact(io, task, 'dev', `02-dev-notes-${n}.md`, c.answer)
      const cwd = task.git.worktree
      await git(io, ['add', '-A'], cwd)
      const staged = await git(io, ['diff', '--cached', '--quiet'], cwd)
      if (staged.exitCode !== 0) {
        const message = `devbench(${task.id}): ${task.title} [dev #${n}]`
        let commit = await git(io, ['commit', '-m', message], cwd)
        if (commit.exitCode !== 0) {
          commit = await git(io, ['-c', 'user.name=devbench', '-c', 'user.email=devbench@localhost', 'commit', '-m', message], cwd)
        }
        if (commit.exitCode !== 0) {
          return finished(io, taskId, ref, { ok: false, note: `提交失败：${tail(commit.stderr)}`, ...usage })
        }
      }
      const diff = await git(io, ['diff', `${task.git.baseSha}..HEAD`], cwd)
      task = await addArtifact(io, task, 'dev', '02-diff.patch', diff.stdout)
      const ok = diff.stdout.trim() !== ''
      return finished(io, taskId, ref, { ok, note: ok ? undefined : '开发阶段没有产生任何代码变更', ...usage })
    }
    case 'review': {
      const verdict = parseVerdict(c.answer)
      await addArtifact(io, task, 'review', `04-review-${task.stages.review.attempts}.json`, JSON.stringify(verdict, null, 2))
      return finished(io, taskId, ref, { ok: verdict.verdict === 'pass', note: verdictFeedback(verdict), ...usage })
    }
    default:
      return
  }
}

// ---------- 命令 ----------

const newTask = async (io: Io, request: string): Promise<string> => {
  if (request.trim() === '') return '用法：/devbench new <需求描述>'
  const inside = await git(io, ['rev-parse', '--is-inside-work-tree'])
  if (inside.exitCode !== 0) return '当前目录不是 git 仓库，devbench 需要在 git 仓库中运行。'
  const top = (await git(io, ['rev-parse', '--show-toplevel'])).stdout.trim()
  if (top !== '') root = top
  const baseSha = (await git(io, ['rev-parse', 'HEAD'])).stdout.trim()
  if (baseSha === '') return '仓库还没有任何提交，请先提交一次再创建任务。'
  const baseBranch = (await git(io, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()

  const now = await io.now()
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, '').slice(2, 12)
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(2)), b => b.toString(16).padStart(2, '0')).join('')
  const id = `${stamp}-${rand}`
  const dir = join(root, DATA_DIR, 'tasks', id)
  const worktree = join(root, DATA_DIR, 'worktrees', id)
  const branch = `devbench/${id}`

  await io.write(join(root, DATA_DIR, '.gitignore'), '*\n')
  const added = await git(io, ['worktree', 'add', '-b', branch, worktree, baseSha])
  if (added.exitCode !== 0) return `创建 worktree 失败：${tail(added.stderr)}`

  const title = request.trim().split('\n')[0]!.slice(0, 60)
  const draft: Task = {
    id,
    title,
    request: request.trim(),
    createdAt: now,
    updatedAt: now,
    status: 'running',
    current: 'spec',
    stages: Object.fromEntries(STAGES.map(s => [s.id, emptyRun(s.id)])) as Task['stages'],
    rework: 0,
    firstPass: {},
    git: { baseBranch, baseSha, branch, worktree },
    dir,
  }
  const config = await loadConfig(io)
  const { task, action } = startTask(draft, now)
  await save(io, task)
  await io.select(id)
  await io.open({ id: PANE, title: 'Devbench' })
  await perform(io, task, action, config)
  const warn = config.test === null ? '\n⚠ 未检测到测试命令，单元测试阶段会被跳过（可在 .devbench.json 配置 testCommand）。' : ''
  return `已创建任务 ${id}：${title}\n分支 ${branch}，worktree ${worktree}${warn}`
}

const HELP = `用法：
/devbench new <需求>      创建任务并开始流水线
/devbench approve         批准当前等待的阶段
/devbench reject <理由>   驳回，必须写理由（Spec 重写 / 合并前回到评审 / 跳过部署）
/devbench retry           重试当前阶段
/devbench skip <理由>     跳过当前等待中或失败的阶段（例如已手动合并）
/devbench abort           中止当前任务
/devbench list            列出任务
/devbench select <id>     切换面板显示的任务
/devbench                 打开面板`

const command = async (io: Io, args: string): Promise<string> => {
  const [sub = '', ...rest] = args.trim().split(/\s+/)
  const arg = args.trim().slice(sub.length).trim()
  switch (sub) {
    case '':
    case 'open':
      await io.open({ id: PANE, title: 'Devbench', focus: true })
      return 'Devbench 面板已打开。'
    case 'new':
      return newTask(io, arg)
    case 'approve':
    case 'reject':
    case 'retry':
    case 'skip':
    case 'abort': {
      const withReason = sub === 'reject' || sub === 'skip'
      const task = await findTask(io, withReason ? undefined : rest[0])
      if (task === undefined) return '没有任务。'
      const event: Event =
        sub === 'reject'
          ? { kind: 'reject', reason: arg }
          : sub === 'skip'
            ? { kind: 'skip', reason: arg || '手动跳过' }
            : { kind: sub }
      const action = await dispatch(io, task.id, event)
      if (action?.kind === 'none' && action.reason !== undefined) return `「${task.title}」：${action.reason}`
      return `「${task.title}」：已${{ approve: '批准', reject: '驳回', retry: '重试', skip: '跳过', abort: '中止' }[sub]}`
    }
    case 'list': {
      const list = await io.tasks()
      if (list.length === 0) return '还没有任务。'
      return list
        .map(t => `${t.id}  ${TASK_LABEL[t.status]}  ${stageDef(t.current).label}  ${t.title}`)
        .join('\n')
    }
    case 'select': {
      const task = await findTask(io, arg)
      if (task === undefined) return `找不到任务 ${arg}`
      await io.select(task.id)
      await io.open({ id: PANE, title: 'Devbench' })
      return `面板已切换到「${task.title}」`
    }
    default:
      return HELP
  }
}

// ---------- 面板 ----------

const StageRow = ({ ui, task, id, now }: { ui: Elements; task: Task; id: StageId; now: number }) => {
  const { Box, Text } = ui
  const run = task.stages[id]
  const active = run.status === 'running' && run.startedAt !== undefined ? now - run.startedAt : 0
  const color =
    run.status === 'passed' ? 'success' : run.status === 'failed' ? 'error' : run.status === 'waiting' ? 'warning' : undefined
  const parts = [
    run.durationMs + active > 0 ? formatDuration(run.durationMs + active) : '',
    run.tokens.output > 0 ? `${formatTokens(inputTotal(run.tokens))} 入 / ${formatTokens(run.tokens.output)} 出` : '',
    run.attempts > 1 ? `第 ${run.attempts} 次` : '',
    run.waitMs > 0 ? `等待 ${formatDuration(run.waitMs)}` : '',
  ].filter(p => p !== '')
  return (
    <Box flexDirection="column">
      <Text color={color} bold={task.current === id && !isTerminal(task)}>
        {STATUS_ICON[run.status]} {stageDef(id).label}  {STATUS_LABEL[run.status]}
        {parts.length > 0 ? `  ${parts.join(' · ')}` : ''}
      </Text>
      {run.artifacts.length > 0 && <Text dimColor>    产物：{run.artifacts.join('、')}</Text>}
      {run.note !== undefined && (run.status === 'failed' || run.status === 'skipped' || run.status === 'waiting') && (
        <Text dimColor wrap="truncate-end">    {run.note.split('\n')[0]}</Text>
      )}
    </Box>
  )
}

type Elements = ReturnType<Engine['ui']['resolve']>

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    io = {
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      exists: path => $.fs.exists(path),
      list: path => $.fs.list(path),
      run: (argv, init) => $.process.run(argv, init),
      spawnProcess: request => $.process.spawn(request),
      spawn: input => $.agent.spawn(input),
      stopAgent: id => $.tool.call({ tool: 'TaskStop', task_id: id }),
      fillPrompt: text => $.prompt.fill({ text, mode: 'replace' }),
      toast: (text, options) => $.ui.toast(text, options),
      notify: (text, options) => $.ui.notify(text, options),
      status: text => $.ui.status(text),
      open: pane => $.ui.open(pane),
      tasks: () => read($, tasksAtom),
      setTasks: fn => update($, tasksAtom, fn),
      selected: () => read($, selectedAtom),
      select: id => update($, selectedAtom, () => id),
    }
    root = e.cwd
    await $.command.register({
      name: 'devbench',
      description: 'AI 开发工作台：需求→开发→测试→评审→合并→部署',
      argumentHint: '[new <需求> | approve | reject <理由> | retry | skip <理由> | abort | list]',
    })
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel']).catch(() => undefined)
    if (top?.exitCode === 0 && top.stdout.trim() !== '') root = top.stdout.trim()
    const onDisk = await loadTasks(io)
    if (onDisk.length > 0) await update($, tasksAtom, () => onDisk)
    await Promise.all([
      $.agent.register({
        name: 'planner',
        description: 'devbench 内部：把需求整理成 Spec',
        prompt: PLANNER_PROMPT,
        // 只读：Spec 阶段在主仓库里运行，不给 Bash，避免改动主工作区。
        tools: ['Read', 'Grep', 'Glob'],
        omitClaudeMd: true,
      }),
      $.agent.register({
        name: 'developer',
        description: 'devbench 内部：在 worktree 中按 Spec 实现',
        prompt: DEVELOPER_PROMPT,
      }),
      $.agent.register({
        name: 'reviewer',
        description: 'devbench 内部：独立评审变更并给出 JSON 结论',
        prompt: REVIEWER_PROMPT,
        tools: ['Read', 'Grep', 'Glob'],
        omitClaudeMd: true,
      }),
    ]).catch(err => $.ui.log(`devbench：注册子 agent 失败 ${String(err)}`, { to: 'debug' }))
    if (onDisk.some(t => !isTerminal(t))) void $.ui.open({ id: PANE, title: 'Devbench' })
    return started
  })

  // 三个阶段 agent 只供流水线使用，不出现在主模型的可选列表里。
  on('agent.offer', { agent: 'devbench:planner' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'devbench:developer' }, () => ({ isOffered: false }))
  on('agent.offer', { agent: 'devbench:reviewer' }, () => ({ isOffered: false }))

  on('command.run', { command: 'devbench' }, async (_$, e) => ({
    text: io === undefined ? 'devbench 尚未初始化，请重启会话后再试。' : await command(io, e.args),
  }))

  // 子 agent 结束：对回到正在运行的阶段。
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId
    const bench = io
    if (agentId === undefined || bench === undefined) return result
    const usage = e.usage
    const status = (await $.agent.list()).find(a => a.id === agentId)?.status
    const completion: Completion = {
      answer: e.answer,
      ok: e.reason === 'answer',
      reason: e.reason,
      final: isFinalAgentStatus(status),
      durationMs: e.durationMs,
      tokens:
        usage === undefined
          ? undefined
          : {
              input: usage.input_tokens,
              output: usage.output_tokens,
              cacheRead: usage.cache_read_input_tokens,
              cacheWrite: usage.cache_creation_input_tokens,
            },
      model: usage?.model,
    }
    const owner = (await read($, tasksAtom)).find(t => t.stages[t.current].agentId === agentId)
    if (owner === undefined) {
      // 可能是 spawn 刚返回、agentId 还没落盘；也可能与 devbench 无关。暂存一小段时间。
      early.set(agentId, completion)
      bench.after(60_000, () => early.delete(agentId))
      return result
    }
    const ref = { stage: owner.current, seq: owner.stages[owner.current].seq }
    if (!completion.final) {
      // 中途的 turn（例如在等后台命令）：只累计用量，等 agent 真正结束。
      const { durationMs, tokens, model } = completion
      bench.after(0, () => {
        void dispatch(bench, owner.id, { kind: 'progress', ...ref, durationMs, tokens, model })
      })
      return result
    }
    bench.after(0, () => {
      void onAgentDone(bench, owner.id, ref, completion)
    })
    return result
  })

  // 任务进行中，推送 / 合并 / 发布 / 部署只能由流水线在批准后执行。
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const active = (await read($, tasksAtom)).some(t => !isTerminal(t))
    if (!active) return next(e)
    const patterns = io === undefined ? compilePatterns() : (await loadConfig(io)).patterns
    const hit = protectedMatch(e.command, patterns)
    if (hit === undefined) return next(e)
    return {
      deny: `devbench：有任务在流水线中，推送、合并、发布、部署由流水线在人工批准后执行（命中规则 /${hit}/）。请使用 /devbench approve。`,
    }
  }).catch((_$, e, next) => (next.called ? next(e) : { deny: 'devbench：受保护命令检查失败，已拦截。' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, tasksAtom)
    const selected = await read($, selectedAtom)
    const now = await $.clock.now()
    const task =
      list.find(t => t.id === selected) ?? [...list].reverse().find(t => !isTerminal(t)) ?? list.at(-1)

    if (task === undefined) {
      return (
        <Box flexDirection="column">
          <Text>还没有任务。</Text>
          <Text dimColor>输入 /devbench new &lt;需求描述&gt; 开始一条流水线。</Text>
        </Box>
      )
    }

    const m = flowMetrics(task, now)
    const others = list.filter(t => t.id !== task.id && !isTerminal(t)).slice(-4)
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold>{task.title}</Text>
          <Text dimColor>
            {task.id} · {TASK_LABEL[task.status]} · {task.git.branch}
          </Text>
        </Box>
        <Box flexDirection="column">
          {STAGES.map(s => (
            <StageRow ui={ui} task={task} id={s.id} now={now} />
          ))}
        </Box>
        <Box flexDirection="column">
          <Text>
            Lead {formatDuration(m.leadMs)} · 执行 {formatDuration(m.processMs)} · 等待 {formatDuration(m.waitMs)} · 流动效率{' '}
            {Math.round(m.efficiency * 100)}%
          </Text>
          <Text>
            Token {formatTokens(inputTotal(m.tokens))} 入 / {formatTokens(m.tokens.output)} 出 · 返工 {m.rework} · 一次通过率{' '}
            {m.firstPassRate === undefined ? '—' : `${Math.round(m.firstPassRate * 100)}%`}
          </Text>
          <Text dimColor wrap="truncate-start">产物目录：{join(task.dir, 'artifacts')}</Text>
        </Box>
        {(task.status === 'waiting' || task.status === 'failed' || task.status === 'aborted') && (
          <Box flexDirection="row" gap={1}>
            {task.status === 'waiting' && (
              <Button key="approve" variant="primary" hotkey="a" onPress={() => void (io && dispatch(io, task.id, { kind: 'approve' }))}>
                批准{stageDef(task.current).label}
              </Button>
            )}
            {task.status === 'waiting' && (
              <Button key="reject" hotkey="r" onPress={() => void (io && askRejectReason(io))}>
                驳回
              </Button>
            )}
            {task.status !== 'waiting' && (
              <Button key="retry" variant="primary" onPress={() => void (io && dispatch(io, task.id, { kind: 'retry' }))}>
                重试当前阶段
              </Button>
            )}
            {(task.status === 'waiting' || task.status === 'failed') && stageDef(task.current).skippable && (
              <Button key="skip" hotkey="s" onPress={() => void (io && dispatch(io, task.id, { kind: 'skip', reason: '在面板中跳过' }))}>
                跳过{stageDef(task.current).label}
              </Button>
            )}
          </Box>
        )}
        {others.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>其他进行中的任务：</Text>
            {others.map(t => (
              <Button key={`select-${t.id}`} plain onPress={() => void update($, selectedAtom, () => t.id)}>
                {t.title} <Text dimColor>{TASK_LABEL[t.status]}</Text>
              </Button>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
