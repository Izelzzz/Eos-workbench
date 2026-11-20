import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Call, Task } from '../src/engine/types.ts'
import type { AskHandler } from '../src/executor/types.ts'
import { keyOf, nonceOf, runTask } from '../src/runner/runner.ts'
import { Store } from '../src/store/store.ts'
import { FakeExecutor, type Script } from './fake-executor.ts'
import { CHANGES, PASS, workflow } from './helpers.ts'

const meta = { repo: '/r', worktree: '/w', branch: 'eos/t', baseSha: 'abc' }
const dbPath = () => join(mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-test-')), 'eos.db')

const setup = (escalate = true, maxRounds = 2) => {
  const path = dbPath()
  const store = new Store(path)
  store.create({ id: 't', request: '加一个求和函数', workflow: workflow({ maxRounds, escalate }), workflowSource: 'yaml', meta }, 0)
  return { store, path }
}

/** 按会话轮流回复：评审第一次要求修改、第二次通过。 */
const reviewOnce: Script = async ({ key }) => {
  if (key.endsWith('/review')) return (reviewOnce as any).n++ === 0 ? CHANGES : PASS
  return `回复 ${key}`
}

test('runs the workflow to done, committing after every developer turn', async () => {
  (reviewOnce as any).n = 0
  const { store } = setup()
  const ex = new FakeExecutor(reviewOnce)
  const writes: string[] = []
  const task = await runTask('t', { store, executor: ex, pollMs: 1, afterWrite: (_t, c) => writes.push(`${c.purpose}@${c.session}`) })
  assert.equal(task.status, 'done')
  assert.deepEqual(writes, ['produce@build', 'respond@build'])
  assert.deepEqual(ex.sent, ['t/c1', 't/c2', 't/c3', 't/c4', 't/c5'])
  assert.equal(task.sessions.build, `s:${keyOf('t', 'build')}`)
})

test('a reply already in the session log is used instead of sending the call again', async () => {
  (reviewOnce as any).n = 0
  const { store } = setup()
  const ex = new FakeExecutor(reviewOnce)
  const first = store.get('t')!.pending as Call
  ex.completed.set(nonceOf('t', first), { sessionId: 's:t/plan', text: '崩溃前已完成的方案', usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 }, ms: 9 })
  const task = await runTask('t', { store, executor: ex, pollMs: 1 })
  assert.equal(ex.sent.includes('t/c1'), false, 'c1 was not resent')
  assert.equal(task.outputs.plan, '崩溃前已完成的方案')
  const calls = task.log.filter(e => e.type === 'call')
  assert.equal(calls.filter(e => e.type === 'call' && e.call === first.id).length, 1, 'usage of c1 counted once')
})

test('an agent question pauses the call until another process answers it', async () => {
  const { store, path } = setup()
  const other = new Store(path)
  const ex = new FakeExecutor(async ({ key, ask }) => {
    if (key.endsWith('/plan')) return `方案：${await ask({ id: 'n1', text: '红色还是绿色？', options: ['红色', '绿色'] }, new AbortController().signal)}`
    return key.endsWith('/review') ? PASS : '实现'
  })
  const answering = (async () => {
    for (;;) {
      const t = other.get('t')!
      if (t.question !== undefined) return other.dispatch('t', { kind: 'answered', questionId: t.question.id, text: '绿色' }, 1, 'cli')
      await new Promise(r => setTimeout(r, 2))
    }
  })()
  const task = await runTask('t', { store, executor: ex, pollMs: 2 })
  await answering
  assert.equal(task.status, 'done')
  assert.equal(task.outputs.plan, '方案：绿色')
  assert.deepEqual(task.log.filter(e => e.type === 'question' || e.type === 'answer').map(e => e.type), ['question', 'answer'])
})

test('after a crash while waiting for an answer, the resent call reuses the open question', async () => {
  const { store, path } = setup()
  const first = store.get('t')!.pending as Call
  store.dispatch('t', { kind: 'asked', call: first.id, question: { id: 'n1', text: '红色还是绿色？' } }, 1, 'executor') // 上一个进程问到一半就退出了
  const other = new Store(path)
  const ex = new FakeExecutor(async ({ key, ask }) => {
    if (key.endsWith('/plan')) return `方案：${await ask({ id: 'n1', text: '红色还是绿色？' }, new AbortController().signal)}`
    return key.endsWith('/review') ? PASS : '实现'
  })
  setTimeout(() => other.dispatch('t', { kind: 'answered', questionId: 'q1', text: '红色' }, 2, 'cli'), 20)
  const task = await runTask('t', { store, executor: ex, pollMs: 2 })
  assert.equal(task.outputs.plan, '方案：红色')
  assert.equal(task.log.filter(e => e.type === 'question').length, 1, 'no duplicate question')
})

test('a failing call leaves the task failed and retryable', async () => {
  const { store } = setup()
  const ex = new FakeExecutor(async () => { throw new Error('连接被重置') })
  const task: Task = await runTask('t', { store, executor: ex, pollMs: 1 })
  assert.equal(task.status, 'failed')
  assert.equal(task.failure, '连接被重置')
  assert.equal(store.dispatch('t', { kind: 'retry' }, 9, 'cli').accepted, true)
})

test('without wait, the runner returns when the loop needs the user', async () => {
  const { store } = setup(false, 1)
  const ex = new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? CHANGES : '回复'))
  const task = await runTask('t', { store, executor: ex, pollMs: 1, wait: false })
  assert.equal(task.status, 'waiting_user')
  assert.equal(task.question?.source, 'loop')
})

test('every call gets a trace: streamed while it runs, replayed from the session log when recovered', async () => {
  (reviewOnce as any).n = 0
  const { store } = setup()
  const ex = new FakeExecutor(reviewOnce)
  const first = store.get('t')!.pending as Call
  ex.completed.set(nonceOf('t', first), { sessionId: 's:t/plan', text: '找回的方案', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, ms: 1 })
  await runTask('t', { store, executor: ex, pollMs: 1 })
  const trace = store.trace('t')
  assert.deepEqual(trace.filter(r => r.call === 'c1').map(r => r.event.kind), ['call_start', 'step_start'], 'recovered call replayed from the log')
  assert.deepEqual(trace.filter(r => r.call === 'c2').map(r => r.event.kind), ['call_start', 'step_start', 'step_end'], 'live call streamed')
})

test('a trace write that fails does not break the agent call', async () => {
  (reviewOnce as any).n = 0
  const { store } = setup()
  const original = store.appendTrace.bind(store)
  store.appendTrace = (id, call, events) => {
    if (events.some(e => e.kind === 'step_start')) throw new Error('database is locked')
    original(id, call, events)
  }
  const lines: string[] = []
  const task = await runTask('t', { store, executor: new FakeExecutor(reviewOnce), pollMs: 1, log: l => lines.push(l) })
  assert.equal(task.status, 'done')
  assert.ok(lines.some(l => l.includes('trace 记录失败：database is locked')))
})

test('a commit that fails after a developer turn fails the call visibly instead of stopping the runner silently', async () => {
  (reviewOnce as any).n = 0
  const { store } = setup()
  const task = await runTask('t', { store, executor: new FakeExecutor(reviewOnce), pollMs: 1, afterWrite: () => { throw new Error('fatal: not a git repository') } })
  assert.equal(task.status, 'failed')
  assert.equal(task.failure, '提交改动失败：fatal: not a git repository')
  assert.equal(task.pending?.node, 'build', 'the developer call is kept for retry')
})
