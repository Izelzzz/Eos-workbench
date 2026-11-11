// 引擎层：命令阶段跑在 $.process.spawn 上，中止或重试时停掉它，旧进程的结果不落到新的运行上。
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Task } from '../types'
import { STAGES, emptyRun } from '../hooks/core/pipeline'

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
    test: { ...emptyRun('test'), status: 'running', attempts: 1, seq: 1, startedAt: 0 },
  },
  rework: 0,
  firstPass: {},
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'devbench/t1', worktree: `${ROOT}/.devbench/worktrees/t1` },
  dir: `${ROOT}/.devbench/tasks/t1`,
})

type Child = { argv: readonly string[]; killed: boolean; exit: (code: number, text: string) => void }

/** 引擎之下的世界：内存文件、git、可控的子进程和子 agent。 */
const world = async ($: Engine, on: On) => {
  const clock = mock.clock(on)
  const files = new Map<string, string>([
    [TASK_FILE, JSON.stringify(testRunning())],
    [`${ROOT}/.devbench.json`, JSON.stringify({ testCommand: ['npm', 'test'], setupCommand: null })],
  ])
  const children: Child[] = []
  const spawned: string[] = []

  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => {
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
    spawned.push((e as { subagent_type?: string }).subagent_type ?? e.subagentType)
    await clock.sleep(1e9)
    return { deny: '测试里不启动子 agent' }
  })
  on('agent.list', () => ({ value: [] }))
  on('agent.register', (_$, e) => ({ value: { agent: e.name } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'client' as const } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: ROOT, surface: null, isInteractive: false })
  const devbench = async (args: string) => {
    const r = await $.command.run({ command: 'devbench', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    await clock.settle()
    return r
  }
  const saved = (): Task => JSON.parse(files.get(TASK_FILE)!) as Task
  return { clock, files, children, spawned, devbench, saved }
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
