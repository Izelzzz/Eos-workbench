// 对话 agent 提议工作流的端到端验证（对话 agent 提议 PR 的 agent 侧）：真实的 dsh、平台 MCP 端点，经命令行 eos chat new 请 agent 设计一个工作流。
// 核对：
// - 发给模型的工具表里有提议工具，全是平台工具；
// - agent 提了至少一条提议，记成待确认，内容能通过保存约定时的检查，没有作废；
// - 约定表一行都没变（提议不保存）；
// - eos chat show 列出了这条提议；模型 key 不在对话记录和命令输出里。
// 用法：node --import tsx scripts/chat-propose-e2e.ts [--fake]
//   --fake：用假模型（不花钱，本地联调；剧本先提一个通不过检查的，再提改好的）。不加就是真实模型，报告写进 docs/e2e/chat-c1/report.json。
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
const OUT = join(ROOT, '.eos', 'chat-propose-e2e')
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

const db = new DatabaseSync(join(DATA, 'eos.db'))
const proposals = db.prepare('SELECT * FROM chat_proposals WHERE chat_id = ? ORDER BY id').all(id ?? '') as { id: number; kind: string; name: string; content: string; voided: string | null }[]
const messages = db.prepare('SELECT role, text, call FROM chat_messages WHERE chat_id = ? ORDER BY seq').all(id ?? '') as { role: string; text: string; call: string | null }[]
const chatTrace = db.prepare('SELECT event FROM chat_trace WHERE chat_id = ?').all(id ?? '') as { event: string }[]
const reads = messages.flatMap(m => (m.call === null ? [] : (JSON.parse(m.call) as { reads: { tool: string; isError: boolean }[] }).reads))
const store = new Store(join(DATA, 'eos.db'))
const conventions = new Conventions(store)
const valid = proposals.filter(p => p.voided === null && conventions.validate(p.kind as 'workflow', p.name, p.content).length === 0)
const offered = id === undefined ? [] : new DshExecutor({ dshHome: join(DATA, 'dsh'), dshBin: dshInstall(ROOT)!.bin, modelKey: () => KEY }).toolsOffered(`chat/${id}`)

const checks: [string, boolean, unknown][] = [
  ['命令成功，有回复', first.code === 0 && messages.map(m => m.role).join(',') === 'user,assistant', first.out.slice(-1500)],
  [
    '发给模型的工具表：8 个只读工具和提议工具，全是平台工具',
    offered.length === TOOLS.length + 1 && offered.includes(`mcp__eos__${PROPOSE_TOOL}`) && offered.every(t => t.startsWith('mcp__eos__')),
    offered,
  ],
  ['agent 用了提议工具', reads.some(r => r.tool === PROPOSE_TOOL), reads],
  ['至少一条提议通过保存时的检查、没有作废', valid.length > 0, proposals.map(p => ({ id: p.id, kind: p.kind, name: p.name, voided: p.voided }))],
  ['约定表一行都没变（提议不保存）', conventionsDump() === before, undefined],
  [
    'eos chat show 列出了提议',
    valid.every(p => show.out.includes(`#${p.id}`)) && show.out.includes('都还没有保存'),
    show.out
      .split('\n')
      .filter(l => l.includes('提议') || l.includes('#'))
      .slice(-6),
  ],
  ['平台持有的模型 key 不在对话记录、提议、对话 trace 和命令输出里', !JSON.stringify([messages, proposals, chatTrace]).includes(KEY) && !outputs.join('\n').includes(KEY), undefined],
  ...(fake ? [['假模型：第一条名字对不上的提议被退回', reads.filter(r => r.tool === PROPOSE_TOOL && r.isError).length === 1, reads] as [string, boolean, unknown]] : []),
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
  proposals: proposals.map(p => ({ id: p.id, kind: p.kind, name: p.name, voided: p.voided, content: p.content })),
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
if (!fake) {
  const evidence = join(ROOT, 'docs', 'e2e', 'chat-c1')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
}
for (const [name, ok] of checks) console.log(`${ok ? '✓' : '✗'} ${name}`)
console.log(`\n报告：${join(OUT, 'report.json')}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
