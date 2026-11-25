import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { reduce } from '../src/engine/machine.ts'
import type { Event } from '../src/engine/types.ts'
import { zeroUsage } from '../src/engine/types.ts'
import { Store } from '../src/store/store.ts'
import { CHANGES, PASS, workflow } from './helpers.ts'

const meta = { repo: '/r', worktree: '/w', branch: 'eos/t', baseSha: 'abc' }
const tmp = () => join(mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-test-')), 'eos.db')

const reply = (call: string, text: string): Event => ({ kind: 'replied', call: call as never, sessionId: 's', text, usage: zeroUsage(), ms: 1 })

test('dispatch persists the reduced state and an append-only event log, including rejected events', () => {
  const store = new Store(tmp())
  const wf = workflow({ maxRounds: 1, escalate: false })
  store.create({ id: 't1', request: '需求', workflow: wf, workflowSource: 'yaml', meta }, 1)
  assert.equal(store.dispatch('t1', reply('c1', '方案'), 2, 'executor').accepted, true)
  assert.equal(store.dispatch('t1', reply('c1', '重复的回复'), 3, 'executor').accepted, false)
  store.dispatch('t1', reply('c2', '实现'), 4, 'executor')
  store.dispatch('t1', reply('c3', PASS), 5, 'executor')
  const task = store.get('t1')!
  assert.equal(task.status, 'done')
  assert.equal(task.outputs.plan, '方案')
  const events = store.events('t1')
  assert.deepEqual(
    events.map(e => [e.seq, e.event.kind, e.accepted]),
    [
      [1, 'created', true],
      [2, 'replied', true],
      [3, 'replied', false],
      [4, 'replied', true],
      [5, 'replied', true],
    ],
  )
  assert.equal(events[2]?.reason, '不是当前这次调用的结果')
  assert.deepEqual(
    store.list().map(s => [s.id, s.status, s.workflow]),
    [['t1', 'done', 't']],
  )
  assert.deepEqual(store.meta('t1'), meta)
})

test('the stored state equals a replay of the accepted events', () => {
  const path = tmp()
  const store = new Store(path)
  const wf = workflow({ maxRounds: 2, escalate: true })
  const created = store.create({ id: 't2', request: '需求', workflow: wf, workflowSource: 'yaml', meta }, 1)
  store.dispatch('t2', reply('c1', '方案'), 2, 'executor')
  store.dispatch('t2', { kind: 'asked', call: 'c2' as never, question: { id: 'n', text: '问题' } }, 3, 'executor')
  store.dispatch('t2', { kind: 'answered', questionId: 'q1', text: '回答' }, 4, 'cli')
  store.close()
  const reopened = new Store(path)
  const replayed = reopened
    .events('t2')
    .slice(1)
    .filter(e => e.accepted)
    .reduce((t, e) => reduce(t, e.event as Event, e.at).task, created)
  assert.deepEqual(reopened.get('t2'), JSON.parse(JSON.stringify(replayed)), 'state is stored as JSON')
})

test('two connections writing the same task never lose an event', () => {
  const path = tmp()
  const a = new Store(path)
  const b = new Store(path)
  a.create({ id: 't3', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'yaml', meta }, 1)
  b.dispatch('t3', { kind: 'asked', call: 'c1' as never, question: { id: 'n', text: '?' } }, 2, 'executor')
  a.dispatch('t3', { kind: 'answered', questionId: 'q1', text: '好' }, 3, 'cli')
  assert.equal(b.get('t3')!.status, 'running', 'b sees the answer written through a')
  assert.equal(b.events('t3').length, 3)
})

test('待通知的越界撤销存得下、读得回，重启后仍然发给同一会话的下一次调用', () => {
  const path = tmp()
  const store = new Store(path)
  store.create({ id: 't4', request: '需求', workflow: workflow({ maxRounds: 2, escalate: false }), workflowSource: 'yaml', meta }, 1)
  store.dispatch('t4', reply('c1', '方案'), 2, 'executor')
  store.dispatch('t4', { ...reply('c2', '实现'), reverted: ['README.md'] } as Event, 3, 'executor')
  assert.deepEqual(store.get('t4')!.scopeNotices, { build: ['README.md'] })
  // 换一个连接读（等于进程重启后续跑）：通知还在，发出去之后才清除。
  const other = new Store(path)
  assert.deepEqual(other.get('t4')!.scopeNotices, { build: ['README.md'] })
  other.dispatch('t4', reply('c3', CHANGES), 4, 'executor')
  const task = other.get('t4')!
  assert.match(task.pending!.purpose === 'respond' ? (task.pending as { prompt: string }).prompt : '', /有改动被撤销[\s\S]*README\.md/)
  assert.deepEqual(task.scopeNotices, {})
})

test('a task saved before conventions and checks existed loads with defaults', () => {
  const store = new Store(':memory:')
  const old = {
    id: 'old',
    request: 'r',
    workflow: {
      name: 'w',
      roles: { dev: { id: 'dev', model: 'm', prompt: 'p', write: 'worktree' }, rev: { id: 'rev', model: 'm', prompt: 'p', write: 'none' } },
      nodes: [{ kind: 'agent', id: 'build', role: 'dev', task: 't', inputs: [] }],
    },
    status: 'running',
    cursor: 0,
    outputs: {},
    sessions: {},
    dialog: { node: 'review', round: 2, escalated: false, phase: 'critique', formatRetries: 0 },
    log: [],
    nextCall: 3,
  }
  store.db.prepare("INSERT INTO tasks VALUES ('old', 1, 1, 'running', 'r', 'w', '', '{}', ?)").run(JSON.stringify(old))
  const t = store.get('old')!
  assert.deepEqual([t.docs, t.fixes, t.dialog?.review, t.workflow.docs, t.scopeNotices], [[], 0, 'reply', [], {}])
  assert.deepEqual(t.workflow.nodes[0], { kind: 'agent', id: 'build', role: 'dev', task: 't', inputs: [], checks: [], maxFixes: 2 })
  assert.deepEqual(t.workflow.roles.dev, { id: 'dev', model: 'm', prompt: 'p', write: 'worktree', writePaths: ['**'], denyTools: [], skills: [], mcp: [] })
  assert.deepEqual(t.workflow.roles.rev?.writePaths, [])
})
