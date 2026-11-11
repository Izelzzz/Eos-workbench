// 引擎层：命令阶段跑在 $.process.spawn 上，中止或重试时停掉它，旧进程的结果不落到新的运行上。
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Task } from '../types'
import { STAGES, emptyRun } from '../hooks/core/pipeline'
import { parseEntries } from '../hooks/core/audit'
import type { AuditEntry } from '../hooks/core/audit'

const ROOT = '/repo'
const TASK_FILE = `${ROOT}/.devbench/tasks/t1/task.json`

const testRunning = (): Task => ({
  id: 't1',
  title: '示例',
  request: '示例需求',
  createdAt: 0,
  updatedAt: 0,
  status: 'running',
  current: 'test',
  stages: {
    ...(Object.fromEntries(STAGES.map(s => [s.id, emptyRun(s.id)])) as Task['stages']),
    spec: { ...emptyRun('spec'), status: 'passed', attempts: 1, seq: 1 },
    dev: { ...emptyRun('dev'), status: 'passed', attempts: 1, seq: 1 },
    test: {
      ...emptyRun('test'),
      status: 'running',
      attempts: 1,
      seq: 1,
      startedAt: 0,
      runs: [{ seq: 1, attempt: 1, cause: 'initial', startedAt: 0, durationMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outcome: 'running', artifacts: [] }],
    },
  },
  rework: 0,
  firstPass: {},
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'devbench/t1', worktree: `${ROOT}/.devbench/worktrees/t1` },
  dir: `${ROOT}/.devbench/tasks/t1`,
})

type Child = { argv: readonly string[]; killed: boolean; exit: (code: number, text: string) => void }

type Options = {
  task?: unknown
  config?: Record<string, unknown>
  extraFiles?: Record<string, string>
  /** agent.spawn 立刻答复（默认一直挂着不返回）。hook 造不出 agentId，所以答复等同于启动失败。 */
  answerSpawn?: boolean
  failEvents?: boolean
}

/** 引擎之下的世界：内存文件、git、可控的子进程和子 agent。 */
const world = async ($: Engine, on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u' })
  const files = new Map<string, string>([
    [TASK_FILE, JSON.stringify(options.task ?? testRunning())],
    [`${ROOT}/.devbench.json`, JSON.stringify({ testCommand: ['npm', 'test'], setupCommand: null, ...options.config })],
    ...Object.entries(options.extraFiles ?? {}),
  ])
  const children: Child[] = []
  const spawned: string[] = []
  const spawns: { subagentType: string; prompt: string; model?: string }[] = []
  const registered: Record<string, unknown>[] = []

  const filled: string[] = []
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
    if (options.failEvents === true && e.path.endsWith('events.jsonl')) throw new Error('EFBIG')
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: [...files.keys()].some(p => p === e.path || p.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$, e) => ({
    value: e.path === `${ROOT}/.devbench/tasks` ? [{ name: 't1', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }] : [],
  }))
  on('process.run', (_$, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv.join(' ') === 'git rev-parse --show-toplevel' ? ROOT : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('process.spawn', async function* (_$, e, next) {
    let exit: (r: { code: number; text: string }) => void = () => undefined
    const exited = new Promise<{ code: number; text: string }>(resolve => (exit = resolve))
    const child: Child = { argv: e.argv, killed: false, exit: (code, text) => exit({ code, text }) }
    children.push(child)
    const killed = new Promise<undefined>(resolve =>
      next.signal.addEventListener('abort', () => {
        child.killed = true
        resolve(undefined)
      }),
    )
    const r = await Promise.race([exited, killed])
    if (r === undefined) return { value: { code: null, signal: 'SIGTERM' } }
    yield { stream: 'stdout' as const, text: r.text }
    return { value: { code: r.code, signal: null } }
  })
  // 子 agent 不是这里要验的：记下请求了哪个，然后一直不返回（挂在模拟时钟上）。
  on('agent.spawn', async (_$, e) => {
    const subagentType = (e as { subagent_type?: string }).subagent_type ?? e.subagentType
    spawned.push(subagentType)
    spawns.push({ subagentType, prompt: e.prompt, model: e.model })
    if (options.answerSpawn === true) return { deny: '测试里不启动子 agent' }
    await clock.sleep(1e9)
    return { deny: '测试里不启动子 agent' }
  })
  on('agent.list', () => ({ value: [] }))
  on('agent.register', (_$, e) => {
    registered.push({ ...e })
    return { value: { agent: e.name } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'client' as const } }))
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true as const }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  const devbench = async (args: string) => {
    const r = await $.command.run({ command: 'devbench', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await clock.settle()
    return r
  }
  const saved = (): Task => JSON.parse(files.get(TASK_FILE)!) as Task
  const events = (): AuditEntry[] => parseEntries(files.get(`${ROOT}/.devbench/tasks/t1/events.jsonl`) ?? '')
  return { clock, files, children, spawned, spawns, registered, devbench, saved, events, filled }
}

test('重试运行中的测试：停掉旧进程，新进程的结果记到新的这次运行上', async ($, on) => {
  const w = await world($, on)
  await w.devbench('retry')
  expect(w.children.map(c => c.argv.join(' '))).toEqual(['npm test'])

  await w.devbench('retry')
  expect(w.children.length).toBe(2)
  expect(w.children[0]!.killed).toBe(true)
  expect(w.children[1]!.killed).toBe(false)

  w.children[1]!.exit(0, '新进程：全部通过')
  await w.clock.settle()
  const task = w.saved()
  expect(task.stages.test.status).toBe('passed')
  expect(task.rework).toBe(0)
  expect(task.current).toBe('review')
  expect(w.files.get(`${task.dir}/artifacts/03-test-1.log`)).toContain('新进程：全部通过')
  expect(w.spawned).toEqual(['devbench:reviewer'])
})

test('中止运行中的测试：停掉进程，任务中止，不再记结果', async ($, on) => {
  const w = await world($, on)
  await w.devbench('retry')
  await w.devbench('abort')
  expect(w.children[0]!.killed).toBe(true)
  const task = w.saved()
  expect(task.status).toBe('aborted')
  expect(task.stages.test.status).toBe('failed')
  expect(task.stages.test.artifacts).toEqual([])
})

test('测试命令超过 600 秒：停掉进程，按失败处理', async ($, on) => {
  const w = await world($, on)
  await w.devbench('retry')
  await w.clock.advance(600_000)
  await w.clock.settle()
  expect(w.children[0]!.killed).toBe(true)
  const task = w.saved()
  expect(task.current).toBe('dev')
  expect(task.rework).toBe(1)
  expect(task.feedback).toContain('超过 600 秒未结束')
})

test('events.jsonl：每次交给状态机的事件一行，带着发起者；被放弃的进程只记用量', async ($, on) => {
  const w = await world($, on)
  await w.devbench('retry')
  await w.devbench('retry')
  await w.devbench('approve')
  w.children[1]!.exit(0, '通过')
  await w.clock.settle()
  const lines = w.events().map(e => `${e.actor} ${e.event.kind}${'seq' in e.event ? `#${e.event.seq}` : ''} ${e.accepted ? '生效' : '未生效'}`)
  expect(lines).toEqual([
    'command retry 生效',
    'command retry 生效',
    'process progress#2 生效',
    'command approve 未生效',
    'process finished#3 生效',
  ])
  const task = w.saved()
  expect(task.stages.test.runs.map(r => `${r.seq}:${r.cause}:${r.outcome}`)).toEqual(['1:initial:abandoned', '2:retry:abandoned', '3:retry:passed'])
  expect(task.stages.test.runs.at(-1)!.artifacts).toEqual(['03-test-1.log'])

  const before = w.files.get(`${ROOT}/.devbench/tasks/t1/events.jsonl`)!
  await w.devbench('abort')
  expect(w.files.get(`${ROOT}/.devbench/tasks/t1/events.jsonl`)!.startsWith(before)).toBe(true)
  expect(w.events().at(-1)).toMatchObject({ actor: 'command', event: { kind: 'abort' }, stage: 'review', after: { status: 'aborted' } })
})

const reviewWaitingMerge = (): Task => {
  const t = testRunning()
  return {
    ...t,
    status: 'waiting',
    current: 'merge',
    stages: {
      ...t.stages,
      test: { ...t.stages.test, status: 'passed' },
      review: { ...emptyRun('review'), status: 'passed', attempts: 1, seq: 1 },
      merge: { ...emptyRun('merge'), status: 'waiting', waitingSince: 0 },
    },
  }
}

test('面板上的批准记为 panel', async ($, on) => {
  const w = await world($, on, { task: reviewWaitingMerge() })
  const ui = await $.ui.mount({
    plugin: 'devbench',
    component: 'Pane',
    requestId: 'devbench',
    surface: 'terminal',
    props: { title: 'Devbench', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  await ui.press({ key: 'approve' })
  await w.clock.settle()
  expect(w.events()[0]).toMatchObject({ actor: 'panel', event: { kind: 'approve' }, stage: 'merge', accepted: true, action: { kind: 'run', stage: 'merge' } })
  await w.devbench('abort')
  expect(w.events().map(e => `${e.actor} ${e.event.kind}`)).toEqual(['panel approve', 'command abort', 'process progress'])
  expect(w.saved().stages.merge.runs.map(r => r.outcome)).toEqual(['abandoned'])

  await ui.press({ key: 'log' })
  await w.clock.settle()
  expect(w.filled).toEqual(['/devbench log t1'])
  await ui.unmount()
})

test('旧版本的 task.json（没有 runs）照常载入并继续推进', async ($, on) => {
  const legacy = JSON.parse(JSON.stringify(testRunning())) as Task
  for (const s of STAGES) delete (legacy.stages[s.id] as Partial<Task['stages']['spec']>).runs
  expect(legacy.stages.test.runs).toBe(undefined)
  const w = await world($, on, { task: legacy })
  await w.devbench('retry')
  w.children[0]!.exit(0, '通过')
  await w.clock.settle()
  const task = w.saved()
  expect(task.current).toBe('review')
  expect(task.stages.spec.runs).toEqual([])
  expect(task.stages.test.runs.map(r => `${r.seq}:${r.cause}:${r.outcome}`)).toEqual(['2:retry:passed'])
})

const devAfterSpec = (): Task => {
  const t = testRunning()
  return {
    ...t,
    status: 'waiting',
    current: 'spec',
    stages: {
      ...t.stages,
      spec: { ...t.stages.spec, status: 'waiting', waitingSince: 0 },
      dev: emptyRun('dev'),
      test: emptyRun('test'),
    },
  }
}

const POTETO = '/home/u/.claude/plugins/cache/x/pstack/1.0/skills/poteto-mode/SKILL.md'

test('阶段配置：模型、effort、skill 用在启动的子 agent 上并记到运行记录；不能预加载的 skill 改为要求先读', async ($, on) => {
  const w = await world($, on, {
    task: devAfterSpec(),
    answerSpawn: true,
    config: {
      models: { developer: 'sonnet' },
      stages: { dev: { model: 'opus', effort: 'high', skills: ['pstack:poteto-mode', 'engineering:code-review'] } },
    },
    extraFiles: {
      '/home/u/.claude/plugins/installed_plugins.json': JSON.stringify({
        plugins: { 'pstack@x': [{ installPath: '/home/u/.claude/plugins/cache/x/pstack/1.0' }] },
      }),
      [POTETO]: '---\nname: poteto-mode\ndisable-model-invocation: true\n---\n# Poteto mode\n',
    },
  })
  await w.devbench('approve')
  await w.clock.settle()
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.subagentType).toBe('devbench:developer')
  expect(w.spawns[0]!.model).toBe('opus')
  expect(w.spawns[0]!.prompt.startsWith(`先完整阅读并遵循 ${POTETO}\n\n`)).toBe(true)
  expect(w.registered.at(-1)).toMatchObject({ name: 'developer', effort: 'high', skills: ['engineering:code-review'] })
  // 测试引擎里 hook 造不出 agentId，spawn 会被当成启动失败；记录 agentId 与配置的 annotateRun 由 runs.test.ts 覆盖。
  expect(w.events().map(e => `${e.actor} ${e.event.kind}`)).toEqual(['command approve', 'system finished'])
})

test('没有 stages 配置时沿用 models：评审默认 sonnet，不带 effort 和 skill', async ($, on) => {
  const w = await world($, on, { task: reviewWaitingMerge() })
  await w.devbench('reject 命名不对')
  expect(w.spawns[0]).toMatchObject({ subagentType: 'devbench:reviewer', model: 'sonnet' })
  const spec = w.registered.filter(r => r.name === 'reviewer').at(-1)!
  expect('effort' in spec || 'skills' in spec).toBe(false)
  expect(w.saved().stages.review.runs.at(-1)).toMatchObject({ seq: 2, cause: 'reject' })
})

const devRunningWithAgent = (): Task => {
  const t = devAfterSpec()
  return {
    ...t,
    status: 'running',
    current: 'dev',
    stages: {
      ...t.stages,
      spec: { ...t.stages.spec, status: 'passed', waitingSince: undefined },
      dev: {
        ...emptyRun('dev'),
        status: 'running',
        attempts: 1,
        seq: 1,
        startedAt: 0,
        agentId: 'a1',
        runs: [{ seq: 1, attempt: 1, cause: 'initial', startedAt: 0, durationMs: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outcome: 'running', agentId: 'a1', artifacts: [] }],
      },
    },
  }
}

test('被中止的子 agent 迟到的 turn：用量记到它那次运行上，任务不变', async ($, on) => {
  on('tool.call', () => ({ result: 'stopped' }))
  on('turn.complete', () => ({ text: '' }))
  const w = await world($, on, { task: devRunningWithAgent() })
  await w.devbench('abort')
  await $.turn.complete({
    answer: '做完了',
    durationMs: 42_000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: 'a1',
    reason: 'answer',
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'opus' },
  } as Parameters<typeof $.turn.complete>[0])
  await w.clock.settle()
  const task = w.saved()
  expect(task.status).toBe('aborted')
  expect(task.stages.dev.durationMs).toBe(0)
  expect(task.stages.dev.runs[0]).toMatchObject({ outcome: 'abandoned', durationMs: 42_000, tokens: { input: 1000, output: 200 }, model: 'opus' })
  expect(w.events().map(e => `${e.actor} ${e.event.kind} ${e.accepted}`)).toEqual(['command abort true', 'agent progress true'])
  expect(w.files.has(`${task.dir}/artifacts/02-diff.patch`)).toBe(false)
})

test('/devbench log：按 events.jsonl 和运行明细输出时间线', async ($, on) => {
  const w = await world($, on)
  await w.devbench('retry')
  await w.devbench('retry')
  w.children[1]!.exit(1, '1 failed')
  await w.clock.settle()
  const { text } = await w.devbench('log')
  const lines = (text ?? '').split('\n').map(l => l.replace(/^  \d\d:\d\d:\d\d  /, '  hh:mm:ss  '))
  expect(lines.slice(0, 8)).toEqual([
    '「示例」 t1 · 进行中',
    '',
    lines[2]!,
    '  hh:mm:ss  [命令] 放弃 单元测试 第 1 次（重试） → 开始 单元测试 第 2 次',
    '  hh:mm:ss  [命令] 放弃 单元测试 第 2 次（重试） → 开始 单元测试 第 3 次',
    '  hh:mm:ss  [进程] 单元测试 第 2 次（已放弃）迟到的用量：0s，只记到这次运行上',
    '  hh:mm:ss  [进程] 单元测试 第 3 次运行结束：失败 · 0s（exit 1） → 开始 代码开发 第 2 次',
    '',
  ])
  expect(lines[2]).toMatch(/^\d{4}-\d\d-\d\d$/)
  expect(text).toContain('  单元测试  1 次，放弃 2 次（0s） · 0s')
  expect((await w.devbench('log nope')).text).toBe('找不到任务 nope')
})

test('events.jsonl 写不进去时流水线照常推进', async ($, on) => {
  const w = await world($, on, { failEvents: true })
  await w.devbench('retry')
  w.children[0]!.exit(0, '通过')
  await w.clock.settle()
  expect(w.saved().current).toBe('review')
  expect(w.events()).toEqual([])
})
