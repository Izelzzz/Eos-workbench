// 引擎的变异测试：在临时副本里逐个改坏 src/engine/machine.ts，跑引擎测试，每个变异都必须让测试失败。
// 证明测试真的在守这些规则，而不是"写了就过"。用法：node --import tsx scripts/mutate-engine.ts
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** [名字, 原文, 改坏后]。原文必须在文件里恰好出现一次。 */
const MUTATIONS: [string, string, string][] = [
  ['不记录已自动重新确认（上游会被无限次请回）', 'const up = withDialog(t, { escalated: true })', 'const up = withDialog(t, { escalated: false })'],
  ['评审意见发回评审自己的会话', "issue(withDialog(task, { phase: purpose }), { node: d.id, session: d.with,", "issue(withDialog(task, { phase: purpose }), { node: d.id, session: d.id,"],
  ['轮次少算一轮', 'if (t.dialog!.round < d.maxRounds)', 'if (t.dialog!.round < d.maxRounds - 1)'],
  ['中止不清空待执行的调用', "return ok(append({ ...task, status: 'aborted', pending: undefined, question: undefined }", "return ok(append({ ...task, status: 'aborted', question: undefined }"],
  ['任何状态都能重试', "if (task.status !== 'failed') return ignore(task, '只有失败的任务可以重试')", 'if (false) return ignore(task, "")'],
  ['接受空回答', "if (text === '') return ignore(task, '回答不能为空')", 'if (false) return ignore(task, "")'],
  ['不校验回复属于哪个调用', 'isCheck(call) || call.id !== event.call || task.status', 'isCheck(call) || task.status'],
  ['不校验失败属于哪个调用', "if (task.pending?.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次调用')", "if (task.pending === undefined || task.status === 'failed') return ignore(task, '不是当前这次调用')"],
  ['提问不要求是当前调用', 'isCheck(task.pending) || task.pending.id !== event.call)', 'isCheck(task.pending))'],
  ['检查进行中接受提问', "if (task.pending === undefined || isCheck(task.pending) || task.pending.id", "if (task.pending === undefined || task.pending.id"],
  ['失败的任务收到提问就离开失败状态', "if (open === undefined && task.status !== 'running') return ignore(task, '不是当前这次调用')", ''],
  ['同一个问题重复提出', "if (open !== undefined && open.text === event.question.text) return ignore(task, '同一个问题已经在等回答')", 'if (false) return ignore(task, "")'],
  ['回答不校验问题 id', "if (task.status !== 'waiting_user' || q?.id !== event.questionId) return ignore(task, '没有待回答的这个问题')", "if (task.status !== 'waiting_user' || q === undefined) return ignore(task, '没有待回答的这个问题')"],
  ['agent 节点有检查也不跑', '(n.checks.length > 0 ? runChecks(task, n) : advance(task, at))', '(advance(task, at))'],
  ['检查没通过也当通过', 'const passed = allPassed(results)', 'const passed = true'],
  ['补齐次数不累加（无限次自动补齐）', 'return issue({ ...task, fixes: task.fixes + 1 }', 'return issue({ ...task, fixes: task.fixes }'],
  ['补齐次数用完也不问用户', 'if (task.fixes < n.maxFixes) {', 'if (true) {'],
  ['进入新节点不清零补齐次数', "dialog: undefined, fixes: 0 }, at)", 'dialog: undefined }, at)'],
  ['用户指示后不重置补齐次数', "issue({ ...task, fixes: 0 }, { node: n.id, session: n.id, role: n.role, purpose: 'fix', prompt: fixInstructPrompt(text) })", "issue(task, { node: n.id, session: n.id, role: n.role, purpose: 'fix', prompt: fixInstructPrompt(text) })"],
  ['对话跳过检查直接评审', 'return d.checks.length > 0 ? runChecks(', 'return false ? runChecks('],
  ['检查通过后不请评审方', 'd.role === undefined ? passRound(task, d, at)', 'true ? passRound(task, d, at)'],
  ['不校验检查结果条数', 'if (event.results.length !== run.checks.length) return ignore', 'if (false) return ignore'],
  ['检查进行中接受模型回复', 'if (call === undefined || isCheck(call) || call.id !== event.call', 'if (call === undefined || call.id !== event.call'],
]

const TESTS = ['tests/engine.test.ts', 'tests/engine.checks.test.ts', 'tests/engine.state-space.test.ts']
const source = readFileSync(join(ROOT, 'src/engine/machine.ts'), 'utf8')
const work = mkdtempSync(join(tmpdir(), 'eos-mutate-'))
for (const dir of ['src', 'tests', 'vendor']) cpSync(join(ROOT, dir), join(work, dir), { recursive: true })
for (const f of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, f), join(work, f))
symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'))

const run = (): { failed: boolean; summary: string } => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--test', ...TESTS], { cwd: work, stdio: 'pipe', timeout: 120_000, encoding: 'utf8' })
    return { failed: false, summary: '全部通过' }
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    const fail = /ℹ fail (\d+)/.exec(out)?.[1]
    return { failed: true, summary: (e as { signal?: string }).signal === 'SIGTERM' ? '超时（状态空间不收敛）' : `${fail ?? '?'} 个测试失败` }
  }
}

const baseline = run()
console.log(`基线（未改动）：${baseline.summary}`)
if (baseline.failed) throw new Error('未改动的代码测试就不通过，先修好再跑变异测试')
let escaped = 0
for (const [name, from, to] of MUTATIONS) {
  if (source.split(from).length !== 2) throw new Error(`变异「${name}」的原文没有恰好出现一次，需要更新脚本`)
  writeFileSync(join(work, 'src/engine/machine.ts'), source.replace(from, to))
  const r = run()
  if (!r.failed) escaped++
  console.log(`${r.failed ? '抓住' : '漏网'}  ${name}：${r.summary}`)
}
writeFileSync(join(work, 'src/engine/machine.ts'), source)
rmSync(work, { recursive: true, force: true })
console.log(`\n${MUTATIONS.length} 个变异，抓住 ${MUTATIONS.length - escaped} 个，漏网 ${escaped} 个`)
process.exit(escaped === 0 ? 0 : 1)
