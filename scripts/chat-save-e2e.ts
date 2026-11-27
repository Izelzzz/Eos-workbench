// 对话 agent 的提议经人确认保存的端到端验证（人侧）：真实的 dsh、平台 MCP 端点；经命令行请 agent 新建一个工作流，再用 eos chat show 看差异、eos chat save 保存。
// 核对：
// - agent 提了至少一条通过检查、没有作废的提议；在保存之前约定表一行都没变；
// - eos chat show 显示了提议的全文（新建）、涉及权限的警告和带确认码的保存命令；
// - 不带 --allow-permissions 保存被拒绝，约定表不变；带上 show 给的确认码之后保存成第 1 版，操作人是 cli，备注写明来自哪个对话、哪个提议；
// - 同一条提议不能再保存一次；保存后 eos chat show 显示「已保存为第 1 版」；
// - 平台持有的模型 key 不在对话记录、提议、对话 trace 和命令输出里。
// 用法：node --import tsx scripts/chat-save-e2e.ts [--fake]
//   --fake：用假模型（不花钱，本地联调）。不加就是真实模型，报告写进 docs/e2e/chat-c2/report.json。
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { PROPOSE_TOOL } from '../src/chat/proposals.ts'
import { TOOLS } from '../src/chat/tools.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { DshExecutor, dshInstall } from '../src/executor/dsh.ts'
import { Store } from '../src/store/store.ts'
import { startFakeModel } from './fake-model/server.ts'
import type { Reply, Request } from './fake-model/script.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'chat-save-e2e')
const DATA = join(OUT, 'data')
const fake = process.argv.includes('--fake')
const KEY = fake ? 'fake-model-key-0123456789' : (process.env.DEEPSEEK_API_KEY ?? 'proxy-injected')
const ASK =
  '帮我设计一个新的工作流，名字叫 review-only：只有两个阶段，先由 spec-writer 模板写规格，再由 reviewer 模板评审规格，评审不通过最多来回 3 轮。参考平台上现有的 standard 工作流的写法。设计好了用提议工具提交。'

const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' })
const codeState = () => ({
  commit: git('rev-parse', 'HEAD').trim(),
  uncommitted: git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(l => l !== ''),
})

rmSync(OUT, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })
const atStart = codeState()
{
  const store = new Store(join(DATA, 'eos.db'))
  new Conventions(store).seed(Date.now())
  store.close()
}
const conventionsDump = () => JSON.stringify(new DatabaseSync(join(DATA, 'eos.db')).prepare('SELECT * FROM conventions ORDER BY kind, name, version').all())
const before = conventionsDump()

// 假模型：读 standard → 提一个名字对不上的（被退回）→ 提改好的 → 回答。
const requests: Request[] = []
const fakeYaml = () => {
  const s = new Store(join(DATA, 'eos.db'))
  const y = s.convention('workflow', 'standard')!.content
  s.close()
  return y.replace(/^name: .*$/m, 'name: review-only')
}
const script = (req: Request): Reply => {
  requests.push(req)
  const done = req.messages.flatMap(m => m.content.filter(b => b.type === 'tool_result')).length
  const tool = `mcp__eos__${PROPOSE_TOOL}`
  if (done === 0) return { kind: 'tool', name: 'mcp__eos__get_convention', input: { kind: 'workflow', name: 'standard' } }
  if (done === 1) return { kind: 'tool', name: tool, input: { kind: 'workflow', name: 'wrong-name', content: fakeYaml(), rationale: '第一次' } }
  if (done === 2) return { kind: 'tool', name: tool, input: { kind: 'workflow', name: 'review-only', content: fakeYaml(), rationale: '按要求设计' } }
  return { kind: 'text', text: '已经提议了工作流 review-only，等你确认后保存。' }
}
const model = fake ? await startFakeModel(() => {}, script) : undefined

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'EOS_MODEL_BASE_URL' && k !== 'DEEPSEEK_BASE_URL' && k !== 'EOS_MASTER_KEY')),
  NODE_USE_ENV_PROXY: '1',
  DEEPSEEK_API_KEY: KEY,
  ...(model === undefined ? {} : { EOS_MODEL_BASE_URL: model.baseUrl }),
}
const run = promisify(execFile)
const outputs: string[] = []
// 异步：假模型在本进程里，同步等待会让它没法回复。
const eos = async (...args: string[]) => {
  try {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args, '--data', DATA], { cwd: ROOT, env, encoding: 'utf8', timeout: 900_000 })
    outputs.push(stdout)
    return { code: 0, out: stdout }
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string }
    const out = `${x.stdout ?? ''}${x.stderr ?? ''}`
    outputs.push(out)
    return { code: 1, out }
  }
}

const first = await eos('chat', 'new', ASK)
const id = /chat send (c[0-9a-z]+)/.exec(first.out)?.[1]
const show = id === undefined ? { code: 1, out: '' } : await eos('chat', 'show', id)
await model?.close()
const beforeSave = conventionsDump()
// 保存第一条通过检查、没有作废的提议：先不带确认参数（新建的工作流涉及权限，应被拒），再带上。
// 要保存的：通过检查、没作废的 review-only 提议（模型可能先提别的）；没有就取第一条通过检查的。
const checkStore = new Store(join(DATA, 'eos.db'))
const checker = new Conventions(checkStore)
const candidates = (
  new DatabaseSync(join(DATA, 'eos.db')).prepare('SELECT id, kind, name, content FROM chat_proposals WHERE chat_id = ? AND voided IS NULL ORDER BY id').all(id ?? '') as {
    id: number
    kind: 'workflow' | 'template'
    name: string
    content: string
  }[]
).filter(p => checker.validate(p.kind, p.name, p.content).length === 0)
checkStore.close()
const chosen = candidates.find(p => p.kind === 'workflow' && p.name === 'review-only') ?? candidates[0]
const target = chosen?.id
// 确认码从 eos chat show 的输出里取：人看到的就是这份。
const code = new RegExp(`chat save ${target} --allow-permissions ([0-9a-f]{8})`).exec(show.out)?.[1]
const refused = target === undefined ? { code: 0, out: '' } : await eos('chat', 'save', String(target))
const afterRefused = conventionsDump()
const saved = target === undefined || code === undefined ? { code: 1, out: '没有确认码' } : await eos('chat', 'save', String(target), '--allow-permissions', code, '--note', 'E2E 确认')
const again = target === undefined ? { code: 0, out: '' } : await eos('chat', 'save', String(target), '--allow-permissions', code ?? '00000000')
const showAfter = id === undefined ? { code: 1, out: '' } : await eos('chat', 'show', id)

const db = new DatabaseSync(join(DATA, 'eos.db'))
const proposals = db.prepare('SELECT * FROM chat_proposals WHERE chat_id = ? ORDER BY id').all(id ?? '') as { id: number; kind: string; name: string; content: string; voided: string | null }[]
const messages = db.prepare('SELECT role, text, call FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(id ?? '') as { role: string; text: string; call: string | null }[]
const chatTrace = db.prepare('SELECT event FROM chat_trace WHERE chat_id = ?').all(id ?? '') as { event: string }[]
const reads = messages.flatMap(m => (m.call === null ? [] : (JSON.parse(m.call) as { reads: { tool: string; isError: boolean }[] }).reads))
const store = new Store(join(DATA, 'eos.db'))
const conventions = new Conventions(store)
const valid = proposals.filter(p => p.voided === null && conventions.validate(p.kind as 'workflow', p.name, p.content).length === 0)
const offered = id === undefined ? [] : new DshExecutor({ dshHome: join(DATA, 'dsh'), dshBin: dshInstall(ROOT)!.bin, modelKey: () => KEY }).toolsOffered(`chat/${id}`)

const row = chosen === undefined ? undefined : store.convention(chosen.kind, chosen.name)
const checks: [string, boolean, unknown][] = [
  ['命令成功，有回复', first.code === 0 && messages.map(m => m.role).join(',') === 'user,assistant', first.out.slice(-1500)],
  [
    '发给模型的工具表：8 个只读工具和提议工具，全是平台工具',
    offered.length === TOOLS.length + 1 && offered.includes(`mcp__eos__${PROPOSE_TOOL}`) && offered.every(t => t.startsWith('mcp__eos__')),
    offered,
  ],
  ['agent 用了提议工具', reads.some(r => r.tool === PROPOSE_TOOL), reads],
  ['至少一条提议通过保存时的检查、没有作废', valid.length > 0, proposals.map(p => ({ id: p.id, kind: p.kind, name: p.name, voided: p.voided }))],
  ['保存之前约定表一行都没变', beforeSave === before, undefined],
  [
    'eos chat show 显示了全文、权限警告和带确认码的保存命令',
    show.out.includes('全文（新建）') && show.out.includes('⚠⚠ 涉及权限改动') && code !== undefined,
    show.out
      .split('\n')
      .filter(l => l.includes('#') || l.includes('⚠') || l.includes('save'))
      .slice(0, 8),
  ],
  ['不带 --allow-permissions 保存被拒绝，约定表不变', refused.code !== 0 && refused.out.includes('--allow-permissions') && afterRefused === before, refused.out.slice(-600)],
  [
    '带上确认码之后保存成第 1 版，操作人 cli，备注写明对话和提议，列出确认了的权限',
    saved.code === 0 && saved.out.includes('已确认：') && row?.version === 1 && row.actor === 'cli' && row.note === `来自对话 ${id} 的提议 #${target}（确认了权限改动）：E2E 确认`,
    { out: saved.out.slice(-400), version: row?.version, actor: row?.actor, note: row?.note },
  ],
  ['保存的内容就是提议的内容', row?.content === proposals.find(p => p.id === target)?.content, undefined],
  ['同一条提议不能再保存一次', again.code !== 0 && again.out.includes('已经保存过'), again.out.slice(-300)],
  ['保存后 eos chat show 显示已保存', showAfter.out.includes('已保存为第 1 版（cli，'), undefined],
  ['平台持有的模型 key 不在对话记录、提议、对话 trace 和命令输出里', !JSON.stringify([messages, proposals, chatTrace]).includes(KEY) && !outputs.join('\n').includes(KEY), undefined],
]
store.close()

const atEnd = codeState()
const report = {
  mode: fake ? 'fake-model' : 'real-model',
  ...atStart,
  ...(atEnd.commit !== atStart.commit ? { commitAtEnd: atEnd.commit } : {}),
  chat: id,
  checks: checks.map(([name, ok, detail]) => ({ name, ok, ...(detail === undefined ? {} : { detail }) })),
  transcript: show.out,
  transcriptAfterSave: showAfter.out,
  proposals: proposals.map(p => ({ id: p.id, kind: p.kind, name: p.name, voided: p.voided, content: p.content })),
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
if (!fake) {
  const evidence = join(ROOT, 'docs', 'e2e', 'chat-c2')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
}
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log(`\n报告：${join(OUT, 'report.json')}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
