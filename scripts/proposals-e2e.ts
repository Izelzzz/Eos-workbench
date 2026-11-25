// 提案审批端到端验证（第 4 块 PR2）：用真实模型跑任务，在任务进行中批准一条改进提案。
// 1. 在 .eos/proposals-e2e 建示例仓库，启动 eos web；把团队规则（导出函数要有带 @example 的 JSDoc）只写进 reviewer 模板（第 2 版），
//    和 PR1 的 E2E 相同的场景；
// 2. 发起任务 A（standard）。A 还在跑的时候，向数据库写入 3 条针对 developer 模板第 1 版的提案（生成提案在 PR3，这里手工写入）：
//    #1 把规则加进 developer 的提示词，通过接口批准 → developer 第 2 版；
//    #2 同样基于第 1 版，通过接口批准 → 过期（409）；#3 通过接口拒绝；
// 3. A 结束后发起任务 B，等它结束；
// 4. 核对：A 用 developer 第 1 版（提示词里没有这条规则），B 用第 2 版（有）；developer 只多了一个版本，备注写明提案号；
//    提案状态依次是 已批准 / 已过期 / 已拒绝；未批准的提案没有改任何约定。
//    另外记下 A、B 各自评审要求修改的次数（只记录，不作为核对：前后对比是 PR5 的事，样本也太少）。
// 用法：node --import tsx scripts/proposals-e2e.ts [端口]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Conventions } from '../src/conventions/conventions.ts'
import { signalsOf } from '../src/engine/evidence.ts'
import { Proposals } from '../src/improve/proposals.ts'
import { Store } from '../src/store/store.ts'
import type { ProposalInput } from '../src/store/types.ts'
import type { DecideResponse, ProposalInfo, TaskDetail } from '../src/web/types.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'proposals-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4332)
const base = `http://127.0.0.1:${port}`
const RULE_REVIEW = '\n  - 团队规则（必须执行）：每个导出的函数都要有 JSDoc 注释，并且包含 @example 用法示例；缺少的一律给出 changes（severity: major），在 issues 里写明哪个函数缺。\n'
const RULE_DEV = '\n  - 团队规则：每个导出的函数都要写 JSDoc 注释，并且包含 @example 用法示例。\n'

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init'],
])
  execFileSync('git', a, { cwd: REPO })

const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], {
  cwd: ROOT,
  env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T
const post = async (path: string, body: unknown) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}

const runTask = async (request: string): Promise<string> => {
  const r = (await post('/api/tasks', { repo: REPO, workflow: 'standard', request })).body as { ok: boolean; id?: string; error?: string }
  if (!r.ok) throw new Error(`发起任务失败：${r.error}`)
  return r.id!
}
const waitDone = async (id: string) => {
  const deadline = Date.now() + 30 * 60_000
  for (;;) {
    const d = await get<TaskDetail>(`/api/tasks/${id}`)
    if (d.question !== undefined) await post(`/api/tasks/${id}/answer`, { questionId: d.question.id, text: d.question.options?.[0] ?? '按你的判断来' })
    if (d.status === 'failed') await post(`/api/tasks/${id}/retry`, {})
    if (d.status === 'done' || d.status === 'aborted') return d
    if (Date.now() > deadline) throw new Error(`超时：${id} ${d.status}`)
    await sleep(3000)
  }
}

const checks: Record<string, boolean> = {}
const facts: Record<string, unknown> = {}
try {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base + '/api/tasks')
      break
    } catch {
      await sleep(500)
    }
  }
  const reviewer = await get<{ versions: { content: string }[] }>('/api/conventions/template/reviewer')
  const saved = (await post('/api/conventions/template/reviewer', { content: reviewer.versions[0]!.content.trimEnd() + RULE_REVIEW, note: 'E2E：团队规则只写在评审模板里' })).body as {
    ok: boolean
    version?: number
  }
  if (!saved.ok || saved.version !== 2) throw new Error(`保存 reviewer 模板失败：${JSON.stringify(saved)}`)

  const a = await runTask('在 src/sum.js 里实现并导出 sum(numbers)：返回数组的和，空数组返回 0；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。')

  // A 进行中：手工写入 3 条提案（PR3 之前没有生成），再通过接口审批。
  const store = new Store(join(DATA, 'eos.db'))
  const proposals = new Proposals(store, new Conventions(store))
  const dev1 = store.convention('template', 'developer')!
  const before = JSON.stringify(['workflow', 'doc', 'template', 'skill'].map(k => store.conventions(k as never)))
  const input = (rationale: string): ProposalInput => ({
    target: { kind: 'template', name: 'developer' },
    baseVersion: dev1.version,
    content: dev1.content.trimEnd() + RULE_DEV,
    rationale,
    evidence: ['(E2E 手工写入)'],
    scope: { workflow: 'standard', tasks: [a] },
    actor: 'e2e',
  })
  const ids = ['评审反复要求导出函数补 @example，开发模板里没有这条规则', '重复的提案（用来验证过期）', '要被拒绝的提案'].map(r => {
    const x = proposals.add(input(r), Date.now())
    if (!x.ok) throw new Error(x.errors.join('；'))
    return x.row.id
  })
  checks['写入提案后约定没有任何变化'] = JSON.stringify(['workflow', 'doc', 'template', 'skill'].map(k => store.conventions(k as never))) === before
  const statusA = (await get<TaskDetail>(`/api/tasks/${a}`)).status
  facts.statusOfAWhenApproved = statusA
  checks['批准时任务 A 还没结束'] = statusA === 'running' || statusA === 'waiting_user'
  const approved = await post(`/api/improve/proposals/${ids[0]}/approve`, { note: 'E2E' })
  const stale = await post(`/api/improve/proposals/${ids[1]}/approve`, {})
  const rejected = await post(`/api/improve/proposals/${ids[2]}/reject`, { reason: '和 #1 重复' })
  facts.responses = { approved, stale, rejected }
  checks['批准返回 200，developer 第 2 版的备注写明提案号'] =
    approved.status === 200 &&
    (approved.body as DecideResponse).ok &&
    store.convention('template', 'developer')!.version === 2 &&
    store.convention('template', 'developer')!.note === `改进提案 #${ids[0]}：评审反复要求导出函数补 @example，开发模板里没有这条规则；E2E`
  checks['基于旧版本的第二条提案批准时返回 409 并过期'] = stale.status === 409 && /已过期/.test((stale.body as { error: string }).error)
  checks['拒绝返回 200'] = rejected.status === 200

  const doneA = await waitDone(a)
  const b = await runTask('在 src/max.js 里实现并导出 max(numbers)：返回最大值，空数组抛出 RangeError；为它写 node:test 测试放在 test/ 目录，`npm test` 必须通过。')
  const doneB = await waitDone(b)

  const list = await get<ProposalInfo[]>('/api/improve/proposals')
  checks['提案状态依次是 已批准 / 已过期 / 已拒绝'] = JSON.stringify(ids.map(id => list.find(p => p.id === id)?.status)) === JSON.stringify(['approved', 'stale', 'rejected'])
  checks['developer 只有 2 个版本'] = store.conventionHistory('template', 'developer').length === 2
  const taskA = store.get(a)!
  const taskB = store.get(b)!
  checks['A、B 都完成'] = doneA.status === 'done' && doneB.status === 'done'
  checks['A 用 developer 第 1 版（创建时的快照，批准不影响进行中的任务），提示词里没有规则'] =
    taskA.workflow.roles.developer?.template?.version === 1 &&
    !taskA.workflow.roles.developer!.prompt.includes('@example') &&
    store.meta(a).conventions?.templates?.find(t => t.name === 'developer')?.version === 1
  checks['B 用 developer 第 2 版，提示词里有规则'] =
    taskB.workflow.roles.developer?.template?.version === 2 &&
    taskB.workflow.roles.developer!.prompt.includes('@example') &&
    store.meta(b).conventions?.templates?.find(t => t.name === 'developer')?.version === 2
  facts.reviewChanges = { [a]: signalsOf(taskA).filter(s => s.kind === 'review_changes').length, [b]: signalsOf(taskB).filter(s => s.kind === 'review_changes').length }
  facts.proposals = list.map(p => ({ id: p.id, status: p.status, events: p.events, latestVersion: p.latestVersion }))
  store.close()
} finally {
  web.kill('SIGTERM')
}

writeFileSync(join(OUT, 'report.json'), JSON.stringify({ checks, facts }, null, 2))
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
console.log('评审要求修改的次数（只记录）：', JSON.stringify(facts.reviewChanges))
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
