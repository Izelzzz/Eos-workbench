// 提案生成端到端验证（第 4 块 PR3）：真实模型跑任务，再用命令行 eos improve 让真实的 improver 生成提案，eos approve 批准。
// 1. 在 .eos/improve-e2e 建示例仓库，启动 eos web；团队规则（导出函数要有带 @example 的 JSDoc）只写进 reviewer 模板第 2 版（PR1 的场景）；
// 2. 并行发起 3 个 standard 任务，提问自动回答、失败自动重试，等全部结束后关掉 web；
// 3. 运行 `eos improve --workflow standard`（真实模型），核对：
//    - 命令成功，至少生成 1 条提案，没有改任何约定；
//    - 每条提案引用的证据都是这些任务里程序归纳出的证据，目标是有证据的约定，内容能通过保存校验、不改权限；
//    - 至少一条提案把 @example 规则写进 developer 模板或约定文档（这个场景要发现的东西）；
// 4. `eos approve <第一条>`，核对生成了新版本、备注写明提案号，`eos proposals` 显示已批准。
// 用法：node --import tsx scripts/improve-e2e.ts [端口]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Conventions } from '../src/conventions/conventions.ts'
import { evidence } from '../src/engine/evidence.ts'
import { permissionChanges } from '../src/improve/guard.ts'
import { Store } from '../src/store/store.ts'
import type { TaskDetail } from '../src/web/types.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'improve-e2e')
const REPO = join(OUT, 'repo')
const DATA = join(OUT, 'data')
const port = Number(process.argv[2] ?? 4333)
const base = `http://127.0.0.1:${port}`
const RULE = '\n  - 团队规则（必须执行）：每个导出的函数都要有 JSDoc 注释，并且包含 @example 用法示例；缺少的一律给出 changes（severity: major），在 issues 里写明哪个函数缺。\n'
const env = { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }
const eos = (...args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args, '--data', DATA], { cwd: ROOT, env, encoding: 'utf8' }) }
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string }
    return { code: x.status, out: `${x.stdout}${x.stderr}` }
  }
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(REPO, { recursive: true })
writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }, null, 2))
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['add', '-A'],
  ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init'],
])
  execFileSync('git', a, { cwd: REPO })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T
const post = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body) })).json()

const web = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'web', '--data', DATA, '--port', String(port)], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] })
const ids: string[] = []
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
  const saved = (await post('/api/conventions/template/reviewer', { content: reviewer.versions[0]!.content.trimEnd() + RULE, note: 'E2E：团队规则只写在评审模板里' })) as {
    ok: boolean
    version?: number
  }
  if (!saved.ok || saved.version !== 2) throw new Error(`保存 reviewer 模板失败：${JSON.stringify(saved)}`)
  for (const [file, fn, spec] of [
    ['sum', 'sum(numbers)', '返回数组的和，空数组返回 0'],
    ['max', 'max(numbers)', '返回最大值，空数组抛出 RangeError'],
    ['avg', 'avg(numbers)', '返回平均值，空数组返回 0'],
  ]) {
    const r = (await post('/api/tasks', {
      repo: REPO,
      workflow: 'standard',
      request: `在 src/${file}.js 里实现并导出 ${fn}：${spec}；为它写 node:test 测试放在 test/ 目录，\`npm test\` 必须通过。`,
    })) as { ok: boolean; id?: string; error?: string }
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
  await sleep(1500)
}

const store = new Store(join(DATA, 'eos.db'))
const snapshot = () => JSON.stringify((['workflow', 'doc', 'template', 'skill'] as const).map(k => store.conventions(k)))
const before = snapshot()
const ev = evidence(ids.map(id => ({ task: store.get(id)!, used: store.meta(id).conventions })))
const improve = eos('improve', '--workflow', 'standard')
const proposals = store.proposals()
const conventions = new Conventions(store)
const checks: Record<string, boolean> = {}
checks['3 个任务都完成'] = ids.every(id => store.get(id)!.status === 'done')
checks['任务里有证据'] = ev.signals.length > 0
checks['eos improve 成功并生成了至少 1 条提案'] = improve.code === 0 && proposals.length > 0
checks['生成提案没有改任何约定'] = snapshot() === before
const ids_ = new Set(ev.signals.map(s => s.id))
const targets = ev.targets.filter(t => t.affected > 0)
checks['每条提案引用的证据都是程序归纳出的证据'] = proposals.every(p => p.evidence.length > 0 && p.evidence.every(id => ids_.has(id)))
checks['每条提案的目标都是有证据的约定，基于当前版本'] = proposals.every(
  p => targets.some(t => t.kind === p.target.kind && t.name === p.target.name) && store.convention(p.target.kind, p.target.name)!.version === p.baseVersion,
)
checks['每条提案的内容能通过保存校验，不改权限'] = proposals.every(
  p =>
    conventions.validate(p.target.kind, p.target.name, p.content).length === 0 &&
    permissionChanges(p.target.kind, store.convention(p.target.kind, p.target.name)!.content, p.content, conventions.lookup()).length === 0,
)
checks['每条提案记下了生成它的模型调用'] = proposals.every(p => p.generator !== undefined && p.generator.usage.output > 0 && p.generator.run !== undefined)
const found = proposals.find(p => (p.target.kind === 'template' && p.target.name === 'developer') || p.target.kind === 'doc')
checks['至少一条提案把 @example 规则写进 developer 模板或约定文档'] =
  found !== undefined && found.content.includes('@example') && !store.convention(found.target.kind, found.target.name)!.content.includes('@example')

const pick = found ?? proposals.at(-1)
const approve = pick === undefined ? { code: -1, out: '' } : eos('approve', String(pick.id), 'E2E 批准')
const after = pick === undefined ? undefined : store.convention(pick.target.kind, pick.target.name)
checks['eos approve 生成了新版本，备注写明提案号'] =
  approve.code === 0 && pick !== undefined && after!.version === pick.baseVersion + 1 && after!.content === pick.content && after!.note.startsWith(`改进提案 #${pick.id}：`)
const list = eos('proposals')
checks['eos proposals 显示已批准'] = list.code === 0 && pick !== undefined && list.out.includes(`#${pick.id}  已批准`)

const report = {
  tasks: ids,
  signals: ev.signals.map(s => ({ id: s.id, kind: s.kind, role: s.role, text: s.text.slice(0, 300) })),
  improve: improve.out,
  approve: approve.out,
  proposalsList: list.out,
  proposals: store
    .proposals()
    .map(p => ({ id: p.id, target: p.target, baseVersion: p.baseVersion, status: p.status, rationale: p.rationale, evidence: p.evidence, generator: p.generator, content: p.content })),
  checks,
}
store.close()
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
console.log(improve.out)
for (const [k, v] of Object.entries(checks)) console.log(`${v ? '✓' : '✗'} ${k}`)
process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
