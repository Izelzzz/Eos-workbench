import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Executor } from '../src/executor/types.ts'
import { acquire } from '../src/runner/lock.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { FakeExecutor } from './fake-executor.ts'
import { CHANGES, PASS } from './helpers.ts'

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

test('create refuses bad input in Chinese and creates nothing', async () => {
  const s = sandbox()
  const sup = supervisor(s)
  const cases: [Parameters<Supervisor['create']>[0], RegExp][] = [
    [{ repo: s.repo, workflow: 'feature', request: '   ' }, /需求不能为空/],
    [{ repo: join(s.dir, 'missing'), workflow: 'feature', request: '需求' }, /找不到目录/],
    [{ repo: join(s.dir, 'not-a-repo'), workflow: 'feature', request: '需求' }, /不是 git 仓库/],
    [{ repo: s.repo, workflow: 'nope', request: '需求' }, /平台上没有工作流「nope」/],
  ]
  for (const [input, error] of cases) {
    const r = await sup.create(input)
    assert.equal(r.ok, false)
    assert.match(!r.ok ? r.error : '', error)
  }
  assert.deepEqual(s.store.list(), [])
})

test('a created task gets its own branch and worktree under the data directory and runs to done', async () => {
  const s = sandbox()
  const sup = supervisor(s)
  const created = await sup.create({ repo: s.repo, workflow: 'feature', request: '加一个函数' })
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
  const writerCalls = task.log.filter(e => e.type === 'call' && task.workflow.roles[e.role]?.write === 'worktree').length
  assert.ok(writerCalls > 0)
  assert.ok(happy.released.filter(w => w === meta.worktree).length >= writerCalls + 1, 'and before every revert of a writer’s changes (Izelzzz/Eos-workbench#28)')
})

test('a task held by another live process is not started here', async () => {
  const s = sandbox()
  const sup = supervisor(s)
  const created = await sup.create({ repo: s.repo, workflow: 'feature', request: '需求' })
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
  const ids: string[] = []
  for (const _ of ['running', 'failed', 'done', 'held']) {
    const c = await sup.create({ repo: s.repo, workflow: 'feature', request: '需求' })
    assert.ok(c.ok)
    ids.push(c.id)
  }
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

test('写到可写范围外的改动在提交前被撤销，提交里只有范围内的改动，下一次提示词带上说明', async () => {
  const s = sandbox()
  const prompts: string[] = []
  let reviewed = 0
  const executor = new FakeExecutor(async ({ key, prompt }) => {
    prompts.push(prompt)
    if (key.endsWith('/review')) return reviewed++ === 0 ? CHANGES : PASS
    const worktree = s.store.meta(key.split('/')[0]!).worktree
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src/sum.ts'), 'export const sum = (a: number, b: number) => a + b\n')
    // 范围外：改掉仓库里原有的文件，再新建一个顶层文件。
    writeFileSync(join(worktree, 'README.md'), '# 被 agent 改了\n')
    writeFileSync(join(worktree, 'secrets.txt'), '不该写的东西\n')
    return '已实现'
  })
  const sup = supervisor(s, executor)
  const wf = `
name: scoped
roles:
  dev: { prompt: 你负责开发, write: worktree, writePaths: [src/**] }
  rev: { prompt: 你负责评审 }
nodes:
  - { id: build, kind: agent, role: dev, task: 实现 sum }
  - { id: review, kind: dialog, role: rev, with: build, maxRounds: 2, task: 评审 }
`
  assert.ok(sup.conventions.save({ kind: 'workflow', name: 'scoped', content: wf, actor: 'web' }, 1).ok)
  const created = await sup.create({ repo: s.repo, workflow: 'scoped', request: '加一个求和函数' })
  assert.ok(created.ok)
  const started = sup.start(created.id)
  assert.ok(started.ok)
  const task = await started.done
  assert.equal(task.status, 'done', task.failure)

  const worktree = s.store.meta(created.id).worktree
  const log = execFileSync('git', ['log', '--name-only', '--format=', `${s.store.meta(created.id).baseSha}..HEAD`], { cwd: worktree, encoding: 'utf8' })
  assert.deepEqual(
    [
      ...new Set(
        log
          .trim()
          .split('\n')
          .filter(l => l !== ''),
      ),
    ],
    ['src/sum.ts'],
    '提交里只有范围内的改动',
  )
  assert.equal(readFileSync(join(worktree, 'README.md'), 'utf8'), '# demo\n', '范围外被改过的文件恢复了')
  assert.equal(existsSync(join(worktree, 'secrets.txt')), false, '范围外新建的文件删掉了')
  assert.equal(existsSync(join(worktree, 'src/sum.ts')), true)
  const first = task.log.find(e => e.type === 'call' && e.purpose === 'produce')
  assert.deepEqual(first?.type === 'call' ? first.reverted : undefined, ['README.md', 'secrets.txt'])
  const respond = prompts.find(p => /评审意见/.test(p))
  assert.match(respond ?? '', /有改动被撤销（超出你的可写范围）[\s\S]*- README\.md\n- secrets\.txt/)
  assert.match(respond ?? '', /你可以改动的路径（任务 worktree 内的 glob）：\n- src\/\*\*/)
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
  const created = await sup.create({ repo: s.repo, workflow: 'notes', request: '加一个求和函数' })
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

test('角色写了没登记的执行器时创建任务就报错，不建任务；登记了的照常创建，运行时按角色把执行器名字交给执行器', async () => {
  const s = sandbox()
  const seen: (string | undefined)[] = []
  const recording = new FakeExecutor(async ({ key }) => (key.endsWith('/review') ? PASS : `回复 ${key}`))
  const send = recording.send.bind(recording)
  recording.send = (p: Parameters<Executor['send']>[0]) => (seen.push(p.spec.executor), send(p))
  const sup = new Supervisor({ store: s.store, executor: recording, dataDir: s.data, pollMs: 2, unknownExecutor: n => (n === 'other' ? undefined : `没有名为「${n}」的执行器`) })
  const wf = (executor: string) =>
    `name: mixed\nroles:\n  dev: { executor: ${executor}, prompt: 写代码, write: worktree }\n  rev: { prompt: 评审 }\nnodes:\n  - { id: build, kind: agent, role: dev, task: 实现 }\n  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }\n`
  assert.ok(sup.conventions.save({ kind: 'workflow', name: 'mixed', content: wf('nope'), actor: 'web' }, 1).ok)
  const bad = await sup.create({ repo: s.repo, workflow: 'mixed', request: '需求' })
  assert.equal(bad.ok, false)
  assert.match(!bad.ok ? bad.error : '', /工作流 mixed 的角色 dev：没有名为「nope」的执行器/)
  assert.deepEqual(s.store.list(), [])
  assert.ok(sup.conventions.save({ kind: 'workflow', name: 'mixed', content: wf('other'), actor: 'web' }, 2).ok)
  const ok = await sup.create({ repo: s.repo, workflow: 'mixed', request: '需求' })
  assert.ok(ok.ok)
  const started = sup.start(ok.id)
  assert.ok(started.ok)
  await started.done
  assert.deepEqual([...new Set(seen)], ['other', undefined], '开发用指定的执行器，评审没写，用默认的')
})
