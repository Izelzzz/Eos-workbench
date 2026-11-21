// 证据归纳端到端验证（第 4 块 PR1）：用真实模型跑几个任务，再从真实的任务日志里归纳证据，和原始事件记录独立核对。
// 1. 在 .eos/evidence-e2e 建示例仓库，启动 eos web；把一条团队规则只写进 reviewer 模板（新存一版）：
//    「每个导出的函数都要有带 @example 的 JSDoc，没有就要求修改」。开发看不到评审的提示词，第一次多半不知道这条规则，
//    评审会要求修改（这正是后面几个 PR 要让改进提案发现、写进 developer 模板或约定文档的情形）。
//    （试过把规则写进仓库里的检查脚本，明文或 base64 编码，agent 都会先读懂、一次就照做，测不出证据。）
// 2. 发起 2 个 standard 任务，提问自动回答，失败自动重试；
// 3. 全部结束后直接读数据库，对每个任务算证据，核对：
//    - 每条证据的 id 指向日志里同一时刻的条目；
//    - 检查失败的条数 = 原始 events 表里 checked 事件中没通过的结果数；
//    - 评审要求修改的条数 = 评审调用之后没有紧跟「第 N 轮通过」、也不是格式重试的次数；
//    - 归到 developer 模板的证据 = 被评判角色用 developer 模板的证据；
//    - 至少有一条检查失败的证据提到这条团队规则；
// 4. 结果写到 report.json 和 evidence.json。
// 用法：node --import tsx scripts/evidence-e2e.ts [端口] [--verify]（--verify：不重新跑任务，只对上次的数据库重新核对）
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { evidence } from '../src/engine/evidence.ts'
import type { CheckResult } from '../src/engine/types.ts'
import { Store } from '../src/store/store.ts'
import type { TaskDetail } from '../src/web/types.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'evidence-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const verifyOnly = process.argv.includes('--verify')
const port = Number(process.argv.slice(2).find(a => /^\d+$/.test(a)) ?? 4331)
const base = `http://127.0.0.1:${port}`

const RULE = '\n  - 团队规则（必须执行）：每个导出的函数都要有 JSDoc 注释，并且包含 @example 用法示例；缺少的一律给出 changes（severity: major），在 issues 里写明哪个函数缺。\n'

if (!verifyOnly) await runTasks()

async function runTasks() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(REPO, { recursive: true })
  writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init']]) execFileSync('git', a, { cwd: REPO })

  const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], {
    cwd: ROOT, env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }, stdio: ['ignore', 'inherit', 'inherit'],
  })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T
  const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })).json()

  const REQUESTS = [
    '在 src/sum.js 里实现并导出 sum(numbers)：返回数组的和，空数组返回 0；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。',
    '在 src/max.js 里实现并导出 max(numbers)：返回最大值，空数组抛出 RangeError；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。',
  ]

  try {
    for (let i = 0; i < 60; i++) { try { await fetch(base + '/api/tasks'); break } catch { await sleep(500) } }
    // 团队规则只写进 reviewer 模板：在内置第 1 版的提示词末尾加上，存成第 2 版。
    const reviewer = await get<{ versions: { content: string }[] }>('/api/conventions/template/reviewer')
    const saved = await post('/api/conventions/template/reviewer', { content: reviewer.versions[0]!.content.trimEnd() + RULE, note: 'E2E：团队规则只写在评审模板里' }) as { ok: boolean; version?: number }
    if (!saved.ok || saved.version !== 2) throw new Error(`保存 reviewer 模板失败：${JSON.stringify(saved)}`)
    const ids: string[] = []
    for (const request of REQUESTS) {
      const r = await post('/api/tasks', { repo: REPO, workflow: 'standard', request }) as { ok: boolean; id?: string; error?: string }
      if (!r.ok) throw new Error(`发起任务失败：${r.error}`)
      ids.push(r.id!)
    }
    const deadline = Date.now() + 40 * 60_000
    for (;;) {
      const ds = await Promise.all(ids.map(id => get<TaskDetail>(`/api/tasks/${id}`)))
      for (const d of ds) if (d.question !== undefined) await post(`/api/tasks/${d.id}/answer`, { questionId: d.question.id, text: d.question.options?.[0] ?? '按你的判断来' })
      for (const d of ds) if (d.status === 'failed') await post(`/api/tasks/${d.id}/retry`, {})
      if (ds.every(d => d.status === 'done' || d.status === 'aborted')) break
      if (Date.now() > deadline) throw new Error(`超时：${ds.map(d => `${d.id} ${d.status}`).join(', ')}`)
      await sleep(3000)
    }
  } finally {
    web.kill('SIGTERM')
    await sleep(1000)
  }
}

const store = new Store(join(DATA, 'eos.db'))
const samples = store.list().map(s => ({ task: store.get(s.id)!, used: store.meta(s.id).conventions }))
const ev = evidence(samples)
const checks: Record<string, boolean> = {}
checks['所有任务都完成'] = samples.every(s => s.task.status === 'done')
checks['每条证据的 id 唯一，格式是 任务:日志下标[:子项]，指向日志里同一时刻的条目'] = new Set(ev.signals.map(s => s.id)).size === ev.signals.length && ev.signals.every(sig => {
  const task = samples.find(s => s.task.id === sig.task)!.task
  return new RegExp(`^${sig.task}:${sig.entry}(:(\\d+|r))?$`).test(sig.id) && task.log[sig.entry]?.at === sig.at
})
// 独立核对：从原始 events 表数没通过的检查结果。
const rawFailed = samples.reduce((n, s) => n + store.events(s.task.id).filter(r => r.accepted && r.event.kind === 'checked')
  .reduce((m, r) => m + ((r.event as { results: CheckResult[] }).results.filter(x => !x.passed).length), 0), 0)
const failed = ev.signals.filter(s => s.kind === 'check_failed').length
checks[`检查失败的证据 ${failed} 条 = 原始事件里没通过的结果 ${rawFailed} 条`] = failed === rawFailed
// 独立核对：评审调用之后（跳过越界撤销的说明）紧跟的不是「第 N 轮通过」、又一次评审（格式重试）或格式失败的说明，就是要求修改。
const rawChanges = samples.reduce((n, s) => n + s.task.log.filter((e, i) => {
  if (e.type !== 'call' || e.purpose !== 'critique') return false
  const next = s.task.log.slice(i + 1).find(x => !(x.type === 'note' && x.text.startsWith('撤销了 ')))
  if (next?.type === 'note' && (/^第 \d+ 轮通过$/.test(next.text) || next.text.startsWith('回复格式无法解析'))) return false
  return !(next?.type === 'call' && next.purpose === 'critique')
}).length, 0)
const changes = ev.signals.filter(s => s.kind === 'review_changes').length
checks[`评审要求修改的证据 ${changes} 条 = 日志里评审没通过的次数 ${rawChanges} 次`] = changes === rawChanges
const dev = ev.targets.find(t => t.kind === 'template' && t.name === 'developer')
const devSignals = ev.signals.filter(sig => {
  const task = samples.find(s => s.task.id === sig.task)!.task
  return sig.role !== undefined && task.workflow.roles[sig.role]?.template?.name === 'developer'
}).map(s => s.id)
checks['归到 developer 模板的证据 = 被评判角色用 developer 模板的证据'] = JSON.stringify(dev?.signals ?? []) === JSON.stringify(devSignals)
checks['任务用的是 reviewer 第 2 版'] = samples.every(s => s.task.workflow.roles.reviewer?.template?.version === 2)
checks['至少一条评审要求修改的证据提到团队规则，并归到 developer 模板'] = ev.signals.some(s => s.kind === 'review_changes' && s.text.includes('@example') && (dev?.signals ?? []).includes(s.id))

const report = {
  tasks: samples.map(s => ({ id: s.task.id, status: s.task.status, calls: s.task.log.filter(e => e.type === 'call').length, used: s.used })),
  counts: Object.fromEntries(ev.targets.map(t => [`${t.kind}/${t.name}`, { tasks: t.tasks, affected: t.affected, versions: t.versions, counts: t.counts }])),
  checks,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(ev, null, 2))
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
