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
  ['评审意见发回评审自己的会话', 'issue(withDialog(task, { phase: purpose }), { node: d.id, session: d.with,', 'issue(withDialog(task, { phase: purpose }), { node: d.id, session: d.id,'],
  ['轮次少算一轮', 'if (t.dialog!.round < d.maxRounds)', 'if (t.dialog!.round < d.maxRounds - 1)'],
  ['中止不清空待执行的调用', "return ok(append({ ...task, status: 'aborted', pending: undefined, question: undefined }", "return ok(append({ ...task, status: 'aborted', question: undefined }"],
  ['任何状态都能重试', "if (task.status !== 'failed') return ignore(task, '只有失败的任务可以重试')", 'if (false) return ignore(task, "")'],
  ['接受空回答', "if (text === '') return ignore(task, '回答不能为空')", 'if (false) return ignore(task, "")'],
  ['不校验回复属于哪个调用', 'isCheck(call) || call.id !== event.call || task.status', 'isCheck(call) || task.status'],
  [
    '不校验失败属于哪个调用',
    "if (task.pending?.id !== event.call || task.status === 'failed') return ignore(task, '不是当前这次调用')",
    "if (task.pending === undefined || task.status === 'failed') return ignore(task, '不是当前这次调用')",
  ],
  ['提问不要求是当前调用', 'isCheck(task.pending) || task.pending.id !== event.call)', 'isCheck(task.pending))'],
  ['检查进行中接受提问', 'if (task.pending === undefined || isCheck(task.pending) || task.pending.id', 'if (task.pending === undefined || task.pending.id'],
  ['失败的任务收到提问就离开失败状态', "if (open === undefined && task.status !== 'running') return ignore(task, '不是当前这次调用')", ''],
  ['同一个问题重复提出', "if (open !== undefined && open.text === event.question.text) return ignore(task, '同一个问题已经在等回答')", 'if (false) return ignore(task, "")'],
  [
    '回答不校验问题 id',
    "if (task.status !== 'waiting_user' || q?.id !== event.questionId) return ignore(task, '没有待回答的这个问题')",
    "if (task.status !== 'waiting_user' || q === undefined) return ignore(task, '没有待回答的这个问题')",
  ],
  ['agent 节点有检查也不跑', '(n.checks.length > 0 ? runChecks(task, n) : advance(task, at))', '(advance(task, at))'],
  ['检查没通过也当通过', 'const passed = allPassed(results)', 'const passed = true'],
  ['补齐次数不累加（无限次自动补齐）', 'return issue({ ...task, fixes: task.fixes + 1 }', 'return issue({ ...task, fixes: task.fixes }'],
  ['补齐次数用完也不问用户', 'if (task.fixes < n.maxFixes) {', 'if (true) {'],
  ['进入新节点不清零补齐次数', 'gate: undefined, fixes: 0 }, at)', 'gate: undefined }, at)'],
  [
    '用户指示后不重置补齐次数',
    "issue({ ...task, fixes: 0 }, { node: n.id, session: n.id, role: n.role, purpose: 'fix', prompt: fixInstructPrompt(text) })",
    "issue(task, { node: n.id, session: n.id, role: n.role, purpose: 'fix', prompt: fixInstructPrompt(text) })",
  ],
  ['对话跳过检查直接评审', 'return d.checks.length > 0 ? runChecks(', 'return false ? runChecks('],
  ['检查通过后不请评审方', 'if (d.role === undefined) return passRound(task, d, at)', 'return passRound(task, d, at)'],
  ['评审方第一次被请来时只给"回复"提示词（缺任务和需求）', "const review = task.sessions[d.id] === undefined ? 'first' : task.dialog!.review", 'const review = task.dialog!.review'],
  ['不校验检查结果条数', 'if (event.results.length !== run.checks.length) return ignore', 'if (false) return ignore'],
  ['检查进行中接受模型回复', 'if (call === undefined || isCheck(call) || call.id !== event.call', 'if (call === undefined || call.id !== event.call'],
  ['越界撤销不记下要通知的会话（agent 永远不知道自己写越界了）', '{ ...task, scopeNotices: { ...task.scopeNotices, [call.session]: reverted } },', 'task,'],
  ['越界撤销记在节点上而不是会话上（通知发错会话）', '{ ...task.scopeNotices, [call.session]: reverted }', '{ ...task.scopeNotices, [call.node]: reverted }'],
  [
    '发出调用时不把越界撤销的说明加进提示词',
    'const prompt = reverted === undefined ? c.prompt : scopeNotice(reverted, roleOf(task.workflow, c.role).writePaths) + c.prompt',
    'const prompt = c.prompt',
  ],
  [
    '越界撤销的说明发出后不清除（每次调用都重复通知）',
    'pending: { ...c, id: nextId(task), prompt }, scopeNotices, nextCall',
    'pending: { ...c, id: nextId(task), prompt }, scopeNotices: task.scopeNotices, nextCall',
  ],
  ['没有越界改动也记成一条通知', 'ok(onReply(reverted.length === 0 ? recorded : noteReverted(recorded, call, reverted, at)', 'ok(onReply(noteReverted(recorded, call, reverted, at)'],
  ['调用日志不记被撤销的越界路径', '...(reverted.length === 0 ? {} : { reverted }),', ''],
  // 卡点（路线图 5a）
  ['卡点接受过期那一次的结论', ' || g.round !== event.round) return ignore', ') return ignore'],
  ['卡点打回改完不重跑检查', "(g.checks.length > 0 ? runChecks(withGate(task, { phase: 'check' }), g) : decide(task, g, at))", 'decide(task, g, at)'],
  ['卡点打回不要求意见', "if (!event.pass && comment === '') return ignore(task, '打回时要写明意见')", 'if (false) return ignore(task, "")'],
  ['agent 验收多打回一次', 'cycle >= g.by.maxRounds', 'cycle > g.by.maxRounds'],
  ['卡点重跑检查没通过也回到卡点', 'if (allPassed(results)) return decide(task, g, at)', 'return decide(task, g, at)'],
  ['打回意见发到卡点自己的会话', "session: g.with, role: roleOfAgent(task, g.with), purpose: 'amend'", "session: g.id, role: roleOfAgent(task, g.with), purpose: 'amend'"],
  ['打回后第几次不加一（过期结论能通过）', 'formatRetries: 0, round: round + 1 })', 'formatRetries: 0 })'],
  [
    '人验收时不进入等待验收（显示成运行中）',
    "if (g.by.kind === 'human') return { ...noted, status: 'waiting_accept', pending: undefined }",
    "if (g.by.kind === 'human') return { ...noted, status: 'running', pending: undefined }",
  ],
  // 修正（路线图 5c）
  ['没完成的任务也接受修正', "if (task.status !== 'done') return ignore(task, '只有已完成的任务可以提交改正或补充')", 'if (false) return ignore(task, "")'],
  [
    '修正可以交给对话节点',
    "if (n?.kind !== 'agent') return ignore(task, `「${event.node}」不是这个工作流里的 agent 节点",
    'if (n === undefined) return ignore(task, `「${event.node}」不是这个工作流里的 agent 节点',
  ],
  ['接受空的修正', "if (text === '') return ignore(task, '改正或补充的内容不能为空')", 'if (false) return ignore(task, "")'],
  ['修正发到别的会话', "{ node: n.id, session: n.id, role: n.role, purpose: 'correct', prompt }", "{ node: n.id, session: task.workflow.nodes[0]!.id, role: n.role, purpose: 'correct', prompt }"],
  ['修正改完不重跑检查', 'if (checks.length === 0) return finishCorrection(task, at)', 'return finishCorrection(task, at)'],
  ['修正后检查没过也结束修正', 'if (allPassed(results)) return finishCorrection(task, at)', 'return finishCorrection(task, at)'],
  ['修正后不推送（漏掉平台动作）', "const platform = wf.nodes.flatMap(n => (n.kind === 'gate' ? [] : n.checks)).filter(c => c.kind === 'platform')", 'const platform: Check[] = []'],
  [
    '修正只跑被修正节点自己的和测试它的检查（修正别的节点时不跑测试就推送）',
    "const program = wf.nodes.flatMap(n => (n.kind === 'gate' ? [] : n.checks)).filter(c => c.kind !== 'platform')",
    "const program = wf.nodes.flatMap(n => (n.kind !== 'gate' && (n.id === _target || (n.kind === 'dialog' && n.with === _target)) ? n.checks : [])).filter(c => c.kind !== 'platform')",
  ],
  ['修正的补齐多一次', 'if (task.correction!.fixes < n.maxFixes)', 'if (task.correction!.fixes <= n.maxFixes)'],
]

const TESTS = ['tests/engine.test.ts', 'tests/engine.checks.test.ts', 'tests/engine.gate.test.ts', 'tests/engine.correction.test.ts', 'tests/engine.state-space.test.ts']
const source = readFileSync(join(ROOT, 'src/engine/machine.ts'), 'utf8')
const work = mkdtempSync(join(tmpdir(), 'eos-mutate-'))
for (const dir of ['src', 'tests', 'vendor']) cpSync(join(ROOT, dir), join(work, dir), { recursive: true })
for (const f of ['package.json', 'tsconfig.json']) cpSync(join(ROOT, f), join(work, f))
symlinkSync(join(ROOT, 'node_modules'), join(work, 'node_modules'))

const run = (): { failed: boolean; summary: string } => {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '--test', ...TESTS], { cwd: work, stdio: 'pipe', timeout: 600_000, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    return { failed: false, summary: '全部通过' }
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? '')
    // 输出不是终端时 node:test 用 TAP 报告（「# fail N」），是终端时用 spec 报告（「ℹ fail N」）。
    const fail = /^(?:ℹ|#) fail (\d+)/m.exec(out)?.[1]
    const err = String((e as { stderr?: string }).stderr ?? '')
    const crashed = /heap out of memory|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|RangeError/.exec(err + String((e as Error).message))?.[0]
    return {
      failed: true,
      summary:
        (e as { signal?: string }).signal === 'SIGTERM'
          ? '超时（状态空间不收敛）'
          : fail !== undefined
            ? `${fail} 个测试失败`
            : `测试进程异常退出（${crashed ?? err.trim().split('\n').at(-1)?.slice(0, 80) ?? '无输出'}）`,
    }
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
