// 引擎层：命令阶段跑在 $.process.spawn 上，中止或重试时停掉它，旧进程的结果不落到新的运行上。
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Task } from '../types'
import { STAGES, emptyRun } from '../hooks/core/pipeline'
import { parseEntries } from '../hooks/core/audit'
import type { AuditEntry } from '../hooks/core/audit'

const ROOT = '/repo'
const TASK_FILE = `${ROOT}/.eos/tasks/t1/task.json`

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
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'eos/t1', worktree: `${ROOT}/.eos/worktrees/t1` },
  dir: `${ROOT}/.eos/tasks/t1`,
})

type Child = { argv: readonly string[]; killed: boolean; exit: (code: number, text: string) => void }

type Options = {
  task?: unknown
  config?: Record<string, unknown>
  extraFiles?: Record<string, string>
  /** agent.spawn 立刻答复（默认一直挂着不返回）。hook 造不出 agentId，所以答复等同于启动失败。 */
  answerSpawn?: boolean
  failEvents?: boolean
  /** 改名前的布局：任务在 .devbench/tasks，配置是 .devbench.json。 */
  legacy?: boolean
  env?: Record<string, string>
  /** claude-code-remote 的回答；不给就当作这个会话没有连接它。 */
  sessions?: () => { content: { type: 'text'; text: string }[]; isError: boolean }
}

/** 引擎之下的世界：内存文件、git、可控的子进程和子 agent。 */
const world = async ($: Engine, on: On, options: Options = {}) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/home/u', ...options.env })
  const base = options.legacy === true ? '.devbench' : '.eos'
  const files = new Map<string, string>([
    [`${ROOT}/${base}/tasks/t1/task.json`, JSON.stringify(options.task ?? testRunning())],
    [`${ROOT}/${base === '.eos' ? '.eos.json' : '.devbench.json'}`, JSON.stringify({ testCommand: ['npm', 'test'], setupCommand: null, ...options.config })],
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
  on('fs.list', (_$, e) => {
    const names = new Set([...files.keys()].filter(p => p.startsWith(`${e.path}/`)).map(p => p.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
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
  const mcpCalls: { server: string; tool: string; args: Record<string, unknown> }[] = []
  on('mcp.call', (_$, e) => {
    mcpCalls.push({ server: e.server, tool: e.tool, args: e.args })
    if (options.sessions === undefined) throw new Error('MCP server "claude-code-remote" is not connected')
    return { value: options.sessions() }
  })
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })

  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  const eos = async (args: string) => {
    const r = await $.command.run({ command: 'eos', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await clock.settle()
    return r
  }
  const saved = (): Task => JSON.parse(files.get(TASK_FILE)!) as Task
  const events = (): AuditEntry[] => parseEntries(files.get(`${ROOT}/.eos/tasks/t1/events.jsonl`) ?? '')
  return { clock, files, children, spawned, spawns, registered, eos, saved, events, filled, mcpCalls, copied }
}

test('重试运行中的测试：停掉旧进程，新进程的结果记到新的这次运行上', async ($, on) => {
  const w = await world($, on)
  await w.eos('retry')
  expect(w.children.map(c => c.argv.join(' '))).toEqual(['npm test'])

  await w.eos('retry')
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
  expect(w.spawned).toEqual(['eos:reviewer'])
})

test('中止运行中的测试：停掉进程，任务中止，不再记结果', async ($, on) => {
  const w = await world($, on)
  await w.eos('retry')
  await w.eos('abort')
  expect(w.children[0]!.killed).toBe(true)
  const task = w.saved()
  expect(task.status).toBe('aborted')
  expect(task.stages.test.status).toBe('failed')
  expect(task.stages.test.artifacts).toEqual([])
})

test('测试命令超过 600 秒：停掉进程，按失败处理', async ($, on) => {
  const w = await world($, on)
  await w.eos('retry')
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
  await w.eos('retry')
  await w.eos('retry')
  await w.eos('approve')
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

  const before = w.files.get(`${ROOT}/.eos/tasks/t1/events.jsonl`)!
  await w.eos('abort')
  expect(w.files.get(`${ROOT}/.eos/tasks/t1/events.jsonl`)!.startsWith(before)).toBe(true)
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
    plugin: 'eos',
    component: 'Pane',
    requestId: 'eos',
    surface: 'terminal',
    props: { title: 'Eos', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  })
  await ui.press({ key: 'approve' })
  await w.clock.settle()
  expect(w.events()[0]).toMatchObject({ actor: 'panel', event: { kind: 'approve' }, stage: 'merge', accepted: true, action: { kind: 'run', stage: 'merge' } })
  await w.eos('abort')
  expect(w.events().map(e => `${e.actor} ${e.event.kind}`)).toEqual(['panel approve', 'command abort', 'process progress'])
  expect(w.saved().stages.merge.runs.map(r => r.outcome)).toEqual(['abandoned'])

  await ui.press({ key: 'log' })
  await w.clock.settle()
  expect(w.filled).toEqual(['/eos log t1'])
  await ui.unmount()
})

test('旧版本的 task.json（没有 runs）照常载入并继续推进', async ($, on) => {
  const legacy = JSON.parse(JSON.stringify(testRunning())) as Task
  for (const s of STAGES) delete (legacy.stages[s.id] as Partial<Task['stages']['spec']>).runs
  expect(legacy.stages.test.runs).toBe(undefined)
  const w = await world($, on, { task: legacy })
  await w.eos('retry')
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
  await w.eos('approve')
  await w.clock.settle()
  expect(w.spawns).toHaveLength(1)
  expect(w.spawns[0]!.subagentType).toBe('eos:developer')
  expect(w.spawns[0]!.model).toBe('opus')
  expect(w.spawns[0]!.prompt.startsWith(`先完整阅读并遵循 ${POTETO}\n\n`)).toBe(true)
  expect(w.registered.at(-1)).toMatchObject({ name: 'developer', effort: 'high', skills: ['engineering:code-review'] })
  // 测试引擎里 hook 造不出 agentId，spawn 会被当成启动失败；记录 agentId 与配置的 annotateRun 由 runs.test.ts 覆盖。
  expect(w.events().map(e => `${e.actor} ${e.event.kind}`)).toEqual(['command approve', 'system finished'])
})

test('没有 stages 配置时沿用 models：评审默认 sonnet，不带 effort 和 skill', async ($, on) => {
  const w = await world($, on, { task: reviewWaitingMerge() })
  await w.eos('reject 命名不对')
  expect(w.spawns[0]).toMatchObject({ subagentType: 'eos:reviewer', model: 'sonnet' })
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
  await w.eos('abort')
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

test('/eos log：按 events.jsonl 和运行明细输出时间线', async ($, on) => {
  const w = await world($, on)
  await w.eos('retry')
  await w.eos('retry')
  w.children[1]!.exit(1, '1 failed')
  await w.clock.settle()
  const { text } = await w.eos('log')
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
  expect((await w.eos('log nope')).text).toBe('找不到任务 nope')
})

test('events.jsonl 写不进去时流水线照常推进', async ($, on) => {
  const w = await world($, on, { failEvents: true })
  await w.eos('retry')
  w.children[0]!.exit(0, '通过')
  await w.clock.settle()
  expect(w.saved().current).toBe('review')
  expect(w.events()).toEqual([])
})

test('改名前 .devbench 里的任务和 .devbench.json 配置仍被读取', async ($, on) => {
  const w = await world($, on, { legacy: true, config: { testCommand: ['make', 'check'] } })
  const listed = await w.eos('list')
  expect(listed.text).toContain('t1')
  await w.eos('retry')
  expect(w.children.at(-1)?.argv).toEqual(['make', 'check'])
  w.children.at(-1)?.exit(0, 'ok')
  await w.clock.settle()
})

const SESSIONS_TEXT = `<other-session nonce="n" untrusted="true">\nheader:\n    ${JSON.stringify({
  ccr: {
    data: [
      { id: 'session_done', title: '博客两个 bug 修复', session_status: 'SESSION_STATUS_IDLE', updated_at: '1970-01-01T00:00:00Z', status_bucket: 'SESSION_STATUS_BUCKET_COMPLETED', post_turn_summary: { recent_action: 'PR #67 已开' } },
      { id: 'session_wait', title: 'Izel profile README', session_status: 'SESSION_STATUS_IDLE', updated_at: '1970-01-01T00:00:00Z', status_bucket: 'SESSION_STATUS_BUCKET_BLOCKED', post_turn_summary: { needs_action: 'PR 要不要我继续盯着?' } },
      { id: 'session_me', title: '个人 AI 开发工作台', session_status: 'SESSION_STATUS_RUNNING', updated_at: '1970-01-01T00:00:00Z', status_bucket: 'SESSION_STATUS_BUCKET_WORKING' },
    ],
    has_more: false,
  },
})}\n</other-session nonce="n">`

const SESSIONS_PANE = {
  plugin: 'eos',
  component: 'Pane',
  requestId: 'eos-sessions',
  props: { title: '所有会话', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('/eos sessions：读 claude-code-remote，等你决定的排最前，标出当前会话，面板能复制链接', async ($, on) => {
  const w = await world($, on, {
    env: { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_me' },
    sessions: () => ({ content: [{ type: 'text', text: SESSIONS_TEXT }], isError: false }),
  })
  const out = (await w.eos('sessions')).text ?? ''
  expect(w.mcpCalls.at(-1)).toEqual({ server: 'claude-code-remote', tool: 'list_sessions', args: { mine: true, limit: 50 } })
  expect(out.indexOf('等你决定')).toBeLessThan(out.indexOf('进行中'))
  expect(out).toContain('PR 要不要我继续盯着?')
  expect(out).toContain('个人 AI 开发工作台（当前会话）')
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...SESSIONS_PANE, surface })
    expect(await ui.find({ type: 'Text', text: /等你决定（1）/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /PR 要不要我继续盯着/ })).toBeDefined()
    await ui.press({ key: 'copy-session_wait' })
    expect(w.copied.at(-1)).toBe('https://claude.ai/code/session_wait')
    await ui.unmount()
  }
})

test('/eos sessions：读不到时说明原因，面板也显示', async ($, on) => {
  const w = await world($, on)
  const out = (await w.eos('sessions')).text ?? ''
  expect(out).toContain('读不到会话列表')
  expect(out).toContain('claude-code-remote')
  const ui = await $.ui.mount({ ...SESSIONS_PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /读不到会话列表/ })).toBeDefined()
  await ui.unmount()
})

test('/eos sessions：面板开着时定时刷新', async ($, on) => {
  let calls = 0
  const w = await world($, on, { sessions: () => (calls++, { content: [{ type: 'text', text: SESSIONS_TEXT }], isError: false }) })
  await w.eos('sessions')
  expect(calls).toBe(1)
  await w.clock.advance(120_000)
  await w.clock.settle()
  expect(calls).toBe(2)
})
