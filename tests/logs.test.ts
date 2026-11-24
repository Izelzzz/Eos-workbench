import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { explain, fixFor, RULES } from '../src/engine/failure.ts'
import { appendLog } from '../src/runner/logs.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { createWebServer } from '../src/web/server.ts'
import { FakeExecutor } from './fake-executor.ts'
import { PASS } from './helpers.ts'
import { Store } from '../src/store/store.ts'

/** 临时目录里的真实 git 仓库，加一个数据目录。 */
const sandbox = () => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-logs-'))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  return { dir, repo, data: join(dir, 'data'), store: new Store(join(dir, 'data', 'eos.db')) }
}

test('常见错误都有对应的修法，认不出的让人看日志', () => {
  const cases: [string, RegExp][] = [
    ['Request failed with status 401 Unauthorized', /API key 无效/],
    ['invalid api key', /API key 无效/],
    ['402 Insufficient Balance', /余额不足/],
    ['429 Too Many Requests', /限流/],
    ['fetch failed: getaddrinfo ENOTFOUND api.deepseek.com', /连不上模型服务/],
    ['connect ECONNREFUSED 127.0.0.1:443', /连不上模型服务/],
    ['提交改动失败：fatal: not a git repository', /worktree 被删除或损坏/],
    ['检查无法执行：spawn npm ENOENT', /检查命令起不来/],
    ['dsh process exited with code 1', /agent 进程意外退出/],
    ['other side closed', /连不上模型服务/],
    ['任务正在被进程 123 运行', /看日志/],
    ['奇怪的错误', /看日志/],
  ]
  for (const [error, fix] of cases) assert.match(fixFor(error), fix, error)
  assert.ok(RULES.length >= 7)
})

test('失败原因写清哪一步、什么原因、怎么修；日志路径不存进失败原因', () => {
  assert.equal(explain({ where: '[build] dev · produce（调用 c2）', error: '429 Too Many Requests', task: 't1' }),
    '哪一步：[build] dev · produce（调用 c2）\n原因：429 Too Many Requests\n怎么修：请求太频繁被限流：等一会儿再重试。处理后在任务页点「重试」，或运行 npm run eos -- retry t1')
  assert.match(explain({ where: 'x', error: 'y', task: 't1', fix: '自定义修法' }), /\n怎么修：自定义修法。/)
})

test('日志每行都带时间；目录不存在时会建出来', () => {
  const s = sandbox()
  const path = join(s.data, 'logs', 'x.log')
  appendLog(path, '第一行\n第二行', Date.UTC(2026, 10, 23, 1, 2, 3))
  assert.equal(readFileSync(path, 'utf8'), '2026-11-23T01:02:03.000Z 第一行\n2026-11-23T01:02:03.000Z 第二行\n')
})

test('任务的进度行和完整错误写进 logs/<任务>.log；任务详情带上日志路径；网页能直接看日志', async () => {
  const s = sandbox()
  const executor = new FakeExecutor(async ({ key }) => {
    if (key.endsWith('/build')) throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { stack: 'Error: connect ECONNREFUSED\n    at TCPConnectWrap (net.js:1)' })
    return key.endsWith('/review') ? PASS : '方案'
  })
  const terminal: string[] = []
  const sup = new Supervisor({ store: s.store, executor, dataDir: s.data, pollMs: 2, log: (_id, l) => terminal.push(l) })
  const created = sup.create({ repo: s.repo, workflow: 'feature', request: '加一个函数' })
  assert.ok(created.ok)
  const started = sup.start(created.id)
  assert.ok(started.ok)
  const task = await started.done
  await sup.idle()
  const path = join(s.data, 'logs', `${created.id}.log`)
  assert.equal(sup.logPath(created.id), path)
  assert.equal(task.status, 'failed')
  assert.match(task.failure ?? '', /^哪一步：\[build\] developer · produce（调用 c2）\n原因：connect ECONNREFUSED 10\.0\.0\.1:443\n怎么修：连不上模型服务/)
  assert.doesNotMatch(task.failure!, /日志：/, '路径不存进失败原因（证据和改进提案里不出现服务器路径）')
  const log = readFileSync(path, 'utf8')
  assert.match(log, /^\S+Z runner 开始（进程 \d+，cli）\n/)
  assert.match(log, /→ \[plan\] planner · produce/)
  assert.match(log, /✗ \[build\] developer · produce（调用 c2）：connect ECONNREFUSED/)
  assert.match(log, /at TCPConnectWrap \(net\.js:1\)/, '完整错误进日志文件')
  assert.ok(!terminal.some(l => l.includes('TCPConnectWrap')), '完整错误不打到终端')

  const server = createWebServer({ store: s.store, supervisor: sup, replay: { traceOf: async () => [] }, staticDir: join(s.dir, 'static') })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    assert.equal(((await (await fetch(`${base}/api/tasks/${created.id}`)).json()) as { logPath: string }).logPath, path)
    const res = await fetch(`${base}/api/tasks/${created.id}/log`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/)
    assert.equal(await res.text(), readFileSync(path, 'utf8'))
    assert.equal((await fetch(`${base}/api/tasks/nope/log`)).status, 404)
    const other = sup.create({ repo: s.repo, workflow: 'feature', request: '还没跑' })
    assert.ok(other.ok)
    assert.ok(!existsSync(sup.logPath(other.id)))
    assert.match(await (await fetch(`${base}/api/tasks/${other.id}/log`)).text(), /^（还没有日志：/)
  } finally {
    await new Promise(r => server.close(r))
  }
})
