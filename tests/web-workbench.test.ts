// 工作台的数据（src/web/workbench.ts）：等你处理的提问、验收、提案，和进行中的任务（进度按工作流节点数、最多 10 个）。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { Credentials } from '../src/credentials/store.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import type { ProposalRow } from '../src/store/types.ts'
import { createWebServer } from '../src/web/server.ts'
import { ACTIVE_LIMIT, readWorkbench, titleOf, workbench, type Workbench } from '../src/web/workbench.ts'
import { FakeExecutor } from './fake-executor.ts'
import { PASS, workflow } from './helpers.ts'

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const META = { repo: '/data/mirrors/acme-app/', worktree: '/data/wt/x', branch: 'eos/x', baseSha: 'abc' }

const withStore = (fn: (store: Store) => void) => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-workbench-'))
  const store = new Store(join(dir, 'eos.db'))
  try {
    fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const reply = (store: Store, id: string, texts: string[], at: number) =>
  texts.forEach((text, i) => assert.ok(store.dispatch(id, { kind: 'replied', call: `c${i + 1}` as never, sessionId: 's', text, usage: zero, ms: 1 }, at + i, 'executor').accepted))

test('工作台：提问和人的验收进「等你处理」，按出现先后；进行中的任务带进度（走完几个节点 / 共几个）和状态', () =>
  withStore(store => {
    const plain = workflow({ maxRounds: 1, escalate: false })
    const gated = workflow({ maxRounds: 1, escalate: false, gate: 'human' })
    store.create({ id: 't1', request: '导出任务列表为 CSV\n细节……', workflow: plain, workflowSource: 'y', meta: META }, 1000)
    store.create({ id: 't2', request: '任务列表支持按状态筛选', workflow: gated, workflowSource: 'y', meta: { ...META, remote: { host: 'github.com', owner: 'acme', name: 'app', webUrl: 'https://github.com/acme/app' } } as never }, 1100)
    store.create({ id: 't3', request: '还在规划', workflow: plain, workflowSource: 'y', meta: META }, 1200)
    // t2 走到人验收的卡点；t1 在开发时 agent 提问（比 t2 晚）
    reply(store, 't2', ['方案', '实现 v1', PASS], 2000)
    reply(store, 't1', ['方案'], 2100)
    assert.ok(store.dispatch('t1', { kind: 'asked', call: 'c2' as never, question: { id: 'q1', text: '要不要包含已中止的任务？', options: ['包含', '不包含'] } }, 3000, 'executor').accepted)

    const w = readWorkbench(store)
    assert.deepEqual(
      w.pending.map(p => [p.kind, 'taskId' in p ? p.taskId : p.id]),
      [
        ['gate', 't2'],
        ['question', 't1'],
      ],
    )
    const q = w.pending[1]!
    assert.ok(q.kind === 'question')
    assert.equal(q.title, '导出任务列表为 CSV')
    assert.equal(q.repo, 'acme-app')
    assert.equal(q.at, 3000)
    assert.deepEqual([q.question.id, q.question.text, q.question.options], ['q1', '要不要包含已中止的任务？', ['包含', '不包含']])
    const g = w.pending[0]!
    assert.ok(g.kind === 'gate')
    assert.deepEqual([g.node, g.round, g.repo], ['accept', 1, 'acme/app'])

    // 等你处理的排在前面（之间按更新时间从新到旧）；进度按工作流的节点数
    assert.deepEqual(
      w.active.map(t => [t.id, t.done, t.total, t.waiting]),
      [
        ['t1', 1, 3, 'question'],
        ['t2', 3, 4, 'gate'],
        ['t3', 0, 3, undefined],
      ],
    )
    assert.equal(w.active[0]!.state, 'build · 等你回答')
    assert.equal(w.active[1]!.state, 'accept · 等你验收')
    assert.equal(w.active[2]!.state, 'plan')
    assert.equal(w.activeTotal, 3)
  }))

test('工作台：已结束的任务不算；待批的提案进「等你处理」，批过、拒过的不进', () => {
  const base = { target: { kind: 'workflow', name: 'standard' }, baseVersion: 12, content: 'x', events: [] } as unknown as ProposalRow
  const proposals = [
    { ...base, id: 1, status: 'pending', rationale: '开发阶段增加「改动要有对应测试」', createdAt: 50 },
    { ...base, id: 2, status: 'approved', rationale: '已批', createdAt: 10 },
    { ...base, id: 3, status: 'rejected', rationale: '已拒', createdAt: 20 },
  ] as ProposalRow[]
  withStore(store => {
    store.create({ id: 't1', request: '做完了', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: META }, 1000)
    reply(store, 't1', ['方案', '实现', PASS], 1100)
    assert.equal(store.get('t1')!.status, 'done')
    const task = store.get('t1')!
    const w = workbench({ tasks: [{ summary: store.list()[0]!, task, meta: META }], proposals })
    assert.deepEqual(w.active, [])
    assert.equal(w.activeTotal, 0)
    assert.deepEqual(w.pending, [{ kind: 'proposal', id: 1, target: { kind: 'workflow', name: 'standard' }, rationale: '开发阶段增加「改动要有对应测试」', at: 50 }])
  })
})

test(`工作台：进行中的任务最多 ${ACTIVE_LIMIT} 个，按更新时间从新到旧，activeTotal 是总数`, () =>
  withStore(store => {
    const wf = workflow({ maxRounds: 1, escalate: false })
    for (let i = 0; i < ACTIVE_LIMIT + 2; i++) store.create({ id: `t${i}`, request: `任务 ${i}`, workflow: wf, workflowSource: 'y', meta: META }, 1000 + i)
    const w = readWorkbench(store)
    assert.equal(w.activeTotal, ACTIVE_LIMIT + 2)
    assert.equal(w.active.length, ACTIVE_LIMIT)
    assert.deepEqual(w.active.slice(0, 2).map(t => t.id), [`t${ACTIVE_LIMIT + 1}`, `t${ACTIVE_LIMIT}`])
  }))

test('工作台：标题是需求的第一行', () => {
  assert.equal(titleOf('  导出 CSV  \n第二行'), '导出 CSV')
  assert.equal(titleOf(''), '')
})

test('接口：GET /api/workbench 返回工作台的数据', async () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-workbench-'))
  mkdirSync(join(dir, 'static'))
  const store = new Store(join(dir, 'eos.db'))
  const credentials = new Credentials(join(dir, 'eos.db'), undefined)
  const supervisor = new Supervisor({ store, executor: new FakeExecutor(async () => '回复'), dataDir: dir, pollMs: 5 })
  const server = createWebServer({ store, supervisor, replay: { traceOf: async () => [] }, staticDir: join(dir, 'static'), credentials })
  try {
    store.create({ id: 't1', request: '需求', workflow: workflow({ maxRounds: 1, escalate: false }), workflowSource: 'y', meta: META }, 1000)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as Workbench
    assert.deepEqual(body, { pending: [], active: [{ id: 't1', title: '需求', repo: 'acme-app', total: 3, done: 0, state: 'plan', updatedAt: 1000 }], activeTotal: 1 })
  } finally {
    await new Promise(r => server.close(r))
    credentials.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
