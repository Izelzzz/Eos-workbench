import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquire } from '../src/runner/lock.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { FakeExecutor } from './fake-executor.ts'
import { PASS } from './helpers.ts'

/** 临时目录里的真实 git 仓库，加一个数据目录。 */
export const sandbox = () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-sup-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init')
  mkdirSync(join(dir, 'not-a-repo'))
  const store = new Store(join(dir, 'data', 'eos.db'))
  return { dir, repo, store, data: join(dir, 'data') }
}

/** 规划、开发照常回复，评审直接通过；developer 每次写一个文件，验证提交。 */
export const happy = new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : `回复 ${key}`))

const supervisor = (s: ReturnType<typeof sandbox>, executor = happy) => new Supervisor({ store: s.store, executor, dataDir: s.data, pollMs: 2 })

test('create refuses bad input in Chinese and creates nothing', () => {
  const s = sandbox()
  const sup = supervisor(s)
  const cases: [Parameters<Supervisor['create']>[0], RegExp][] = [
    [{ repo: s.repo, workflow: 'feature', request: '   ' }, /需求不能为空/],
    [{ repo: join(s.dir, 'missing'), workflow: 'feature', request: '需求' }, /找不到目录/],
    [{ repo: join(s.dir, 'not-a-repo'), workflow: 'feature', request: '需求' }, /不是 git 仓库/],
    [{ repo: s.repo, workflow: 'nope', request: '需求' }, /平台上没有工作流「nope」/],
  ]
  for (const [input, error] of cases) {
    const r = sup.create(input)
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', error)
  }
  assert.deepEqual(s.store.list(), [])
})

test('a created task gets its own branch and worktree under the data directory and runs to done', async () => {
  const s = sandbox()
  const sup = supervisor(s)
  const created = sup.create({ repo: s.repo, workflow: 'feature', request: '加一个函数' })
  assert.ok(created.ok)
  const meta = s.store.meta(created.id)
  assert.equal(meta.branch, `eos/${created.id}`)
  assert.ok(meta.worktree.startsWith(s.data) && existsSync(meta.worktree))
  assert.equal(s.store.events(created.id)[0]?.actor, 'cli')
  const started = sup.start(created.id)
  assert.ok(started.ok)
  assert.equal(sup.running(created.id), true)
  const second = sup.start(created.id)
  assert.deepEqual(second, { ok: false, error: '任务已经在运行' })
  const task = await started.done
  assert.equal(task.status, 'done')
  assert.equal(sup.running(created.id), false, 'lock released when the runner ends')
  assert.deepEqual(happy.released.slice(-1), [meta.worktree], 'the task’s agent processes are released when its runner ends')
})

test('a task held by another live process is not started here', () => {
  const s = sandbox()
  const sup = supervisor(s)
  const created = sup.create({ repo: s.repo, workflow: 'feature', request: '需求' })
  assert.ok(created.ok)
  const other = acquire(sup.locksDir, created.id) // 模拟命令行的 runner 已经在跑
  assert.ok('release' in other)
  const started = sup.start(created.id)
  assert.equal(started.ok, false)
  assert.match(!started.ok ? started.error : '', /正在被进程 \d+ 运行/)
  assert.equal(sup.running(created.id), true, 'the page still sees a runner')
  other.release()
})

test('resumeAll picks up unfinished tasks that nobody runs and leaves failed and finished ones alone', async () => {
  const s = sandbox()
  const sup = supervisor(s)
  const ids = ['running', 'failed', 'done', 'held'].map(() => {
    const c = sup.create({ repo: s.repo, workflow: 'feature', request: '需求' })
    assert.ok(c.ok)
    return c.id
  })
  const [running, failed, done, held] = ids as [string, string, string, string]
  s.store.dispatch(failed, { kind: 'call_failed', call: 'c1' as never, error: '网络错误' }, 1, 'executor')
  s.store.dispatch(done, { kind: 'abort' }, 1, 'cli')
  const lock = acquire(sup.locksDir, held)
  const resumed = sup.resumeAll()
  assert.deepEqual(resumed, [running])
  await sup.idle()
  assert.equal(s.store.get(running)!.status, 'done')
  assert.equal(s.store.get(failed)!.status, 'failed')
  if ('release' in lock) lock.release()
})

test('platform conventions drive a task: docs are injected, versions recorded, and a missing deliverable is sent back and fixed', async () => {
  const s = sandbox()
  const prompts: string[] = []
  let sup: Supervisor
  const executor = new FakeExecutor(async ({ key, prompt }) => {
    prompts.push(prompt)
    const id = key.split('/')[0]!
    // 第一次交付故意漏掉"改动"一节；被退回补齐后写全。
    if (/交付物检查没有通过/.test(prompt)) writeFileSync(join(s.store.meta(id).worktree, 'NOTES.md'), '# 说明\n## 改动\n加了 sum\n')
    else writeFileSync(join(s.store.meta(id).worktree, 'NOTES.md'), '# 说明\n')
    return '已完成'
  })
  sup = supervisor(s, executor)
  assert.ok(sup.conventions.save({ kind: 'doc', name: '小组约定', content: '函数要有注释', actor: 'web' }, 1).ok)
  const wf = `
name: notes
docs: [小组约定]
roles:
  dev: { prompt: 你负责开发, write: worktree }
nodes:
  - { id: build, kind: agent, role: dev, task: 实现并写 NOTES.md, deliverables: [{ path: NOTES.md, sections: [改动] }] }
`
  const saved = sup.conventions.save({ kind: 'workflow', name: 'notes', content: wf, actor: 'web' }, 2)
  assert.ok(saved.ok, JSON.stringify(!saved.ok && saved.errors))
  const created = sup.create({ repo: s.repo, workflow: 'notes', request: '加一个求和函数' })
  assert.ok(created.ok)
  assert.deepEqual(s.store.meta(created.id).conventions, { workflow: { name: 'notes', version: 1 }, docs: [{ name: '小组约定', version: 1 }], templates: [], skills: [] })
  // 任务创建之后再改约定，不影响这个任务。
  sup.conventions.save({ kind: 'doc', name: '小组约定', content: '改过的约定', actor: 'web' }, 3)
  const started = sup.start(created.id)
  assert.ok(started.ok)
  const task = await started.done
  assert.equal(task.status, 'done', task.failure)
  assert.match(prompts[0]!, /团队约定：小组约定（第 1 版）\n\n函数要有注释/)
  assert.match(prompts[1]!, /交付物检查没有通过[\s\S]*缺少章节：改动/)
  const checks = task.log.flatMap(e => (e.type === 'check' ? [e.results[0]!.passed] : []))
  assert.deepEqual(checks, [false, true])
  assert.match(readFileSync(join(s.store.meta(created.id).worktree, 'NOTES.md'), 'utf8'), /## 改动/)
})
