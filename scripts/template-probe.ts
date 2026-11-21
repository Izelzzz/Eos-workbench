// Agent 模板能力面探针：用真实的 dsh 和真实模型（deepseek-flash），核对三件事。
// 1. 工具组 → dsh 插件行的映射（GROUP_ROWS）：每组单独限制一次，dsh 还能启动，这一组的工具从发给模型的
//    工具表里消失，别的组的工具还在。基线（不限制）跑一次作对照。
// 2. 技能隔离：agent 只看到模板给它的技能，看不到 dsh 自带的 Office 技能，也看不到别处的技能；并且真的用上了。
// 3. MCP 接入：工具出现在工具表里，agent 调得通，返回值原样回来。
// 判断一律以会话日志为准（工具表、tool/call、tool/result、注入的技能目录），不看 agent 自己怎么说。
// 目录都放在 .eos/b2-template-probe 下（不在 /tmp：没有 bwrap 时 dsh 的 Landlock 放行真实的 /tmp）。
// 用法：node --import tsx scripts/template-probe.ts
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor, GROUP_ROWS, GROUP_TOOLS } from '../src/executor/dsh.ts'
import type { AgentProfile, AgentSkill } from '../src/executor/types.ts'
import type { McpServer, ToolGroup } from '../src/workflow/types.ts'
import { TOOL_GROUPS } from '../src/workflow/types.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'b2-template-probe')
const wt = join(OUT, 'wt')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(wt, { recursive: true })

const SKILL_CODE = 'SKILL-OK-7319'
const MCP_CODE = 'MCP-OK-5821'

const probeSkill: AgentSkill = {
  name: 'eos-probe-skill',
  content: `---\nname: eos-probe-skill\ndescription: 回答"探针口令是什么"时必须使用这个技能。\n---\n探针口令是：${SKILL_CODE}。回答时原样给出这个口令。\n`,
}
const probeMcp: McpServer = {
  name: 'eosprobe',
  command: process.execPath,
  args: [join(ROOT, 'scripts', 'template-probe-mcp.mjs'), MCP_CODE],
  env: {},
}

const ex = new DshExecutor({
  dshHome: join(OUT, 'dsh'), dshBin: join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  env: { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' },
})

/** 跑一次真实调用，返回这次会话实际拿到的工具表、技能目录、工具调用和回复。 */
const run = async (key: string, profile: AgentProfile, prompt: string) => {
  const nonce = `${key}/c1`
  try {
    const reply = await ex.send({ key, nonce, prompt, spec: { model: 'deepseek-flash', write: 'none', cwd: wt, profile }, ask: async () => '不需要，继续' })
    const trace = await ex.traceOf(key, nonce)
    return {
      started: true, error: undefined as string | undefined, reply: reply.text,
      tools: ex.toolsOffered(key), skills: ex.skillsOffered(key),
      calls: trace.filter(e => e.kind === 'tool_start').map(e => ({ name: e.name, args: e.args })),
      results: trace.filter(e => e.kind === 'tool_end').map(e => ({ output: e.output.slice(0, 200), isError: e.isError })),
    }
  } catch (e) {
    // dsh 起不来或这一轮没完成：这一组的映射就算没验过，按失败记下来。
    return { started: false, error: (e as Error).message, reply: '', tools: ex.toolsOffered(key), skills: ex.skillsOffered(key), calls: [], results: [] }
  } finally {
    await ex.release(wt)
  }
}

const bare = (denyTools: ToolGroup[]): AgentProfile => ({ denyTools, skills: [], mcp: [], background: true })
const TRIVIAL = '只回答一个字：好。不要调用任何工具。'

// ① 基线：什么都不限制，记下这套 dsh 实际提供的工具表。
const baseline = await run('probe/baseline', bare([]), TRIVIAL)
const has = (name: string) => baseline.tools.includes(name)

// ② 每个工具组单独限制一次。
const groups: Record<string, unknown>[] = []
for (const g of TOOL_GROUPS) {
  const r = await run(`probe/group-${g}`, bare([g]), TRIVIAL)
  // 这组该消失的工具：以基线里真的存在的为准（基线里就没有的工具，这次跑证明不了什么）。
  const target = GROUP_TOOLS[g].filter(has)
  const others = TOOL_GROUPS.filter(x => x !== g).flatMap(x => GROUP_TOOLS[x]).filter(has)
  groups.push({
    group: g, rows: GROUP_ROWS[g], started: r.started, error: r.error,
    expectedGone: target, stillThere: target.filter(t => r.tools.includes(t)),
    othersExpected: others, othersMissing: others.filter(t => !r.tools.includes(t)),
    notInBaseline: GROUP_TOOLS[g].filter(t => !has(t)),
    tools: r.tools,
    ok: r.started && target.length > 0 && target.every(t => !r.tools.includes(t)) && others.every(t => r.tools.includes(t)),
  })
}

// ③ 组合：限制 web / subagent / bash，带一个技能和一个 MCP 服务。
const denied: ToolGroup[] = ['web', 'subagent', 'bash']
const combined = await run('probe/combined', { denyTools: denied, skills: [probeSkill], mcp: [probeMcp], background: true }, [
  '严格按顺序做下面每一步，某一步做不到也继续下一步，最后逐条报告结果。',
  '1. 探针口令是什么？（按可用技能回答，原样给出口令）',
  `2. 调用 MCP 工具 mcp__${probeMcp.name}__probe_code，原样给出它返回的内容。`,
  '3. 试着调用 web_fetch、subagent 和 bash 这三个工具；每一个都说明你到底有没有这个工具。',
  '4. 原样列出你现在能看到的全部技能名。',
].join('\n'))

const mcpTool = `mcp__${probeMcp.name}__probe_code`
const deniedTools = denied.flatMap(g => GROUP_TOOLS[g]).filter(has)
const keptTools = ['read', 'write', 'edit', 'glob', 'grep', 'skill', 'ask_user_question'].filter(has)
const checks = [
  { name: '技能：模板给的技能真的被用上了（日志里有 skill 调用）', ok: combined.calls.some(c => c.name === 'skill' && c.args.includes(probeSkill.name)) },
  { name: '技能：口令出现在回复里（技能内容确实到了模型手上）', ok: combined.reply.includes(SKILL_CODE) },
  { name: '技能隔离：会话里只有模板给的技能，没有 dsh 自带的 Office 技能', ok: combined.skills.length === 1 && combined.skills[0] === probeSkill.name },
  { name: 'MCP：工具出现在工具表里', ok: combined.tools.includes(mcpTool) },
  { name: 'MCP：agent 调用了它', ok: combined.calls.some(c => c.name === mcpTool) },
  { name: 'MCP：返回值原样回来了', ok: combined.results.some(r => r.output.includes(MCP_CODE) && !r.isError) },
  { name: '限制的工具组：工具表里一个都没有', ok: deniedTools.length > 0 && deniedTools.every(t => !combined.tools.includes(t)) },
  { name: '限制的工具组：agent 一次也没调到（日志里没有这些工具调用）', ok: !combined.calls.some(c => deniedTools.includes(c.name)) },
  { name: '没限制的工具还在（读写文件、技能、提问）', ok: keptTools.length >= 6 && keptTools.every(t => combined.tools.includes(t)) },
  { name: '组合这一轮正常跑完（限制之后 dsh 照常启动）', ok: combined.started },
]

const here = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const allOk = baseline.started && groups.every(g => g.ok === true) && checks.every(c => c.ok)
const report = {
  code: { commit: here('rev-parse', '--short', 'HEAD'), uncommitted: here('status', '--porcelain', '--', 'src', 'scripts', 'tests').split('\n').filter(Boolean) },
  dsh: String(JSON.parse(execFileSync('node', ['-p', 'JSON.stringify(require("@deepseek-ai/dsh/package.json").version)'], { cwd: ROOT, encoding: 'utf8' }))),
  model: 'deepseek-flash',
  allOk,
  baseline: { started: baseline.started, error: baseline.error, tools: baseline.tools },
  groups,
  combined: {
    denied, checks, tools: combined.tools, skills: combined.skills,
    calls: combined.calls.map(c => c.name), results: combined.results, reply: combined.reply, error: combined.error,
  },
}
const dir = join(ROOT, 'docs', 'e2e', 'b2')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'template-probe.json'), `${JSON.stringify(report, null, 2)}\n`)

console.log(`基线工具表（${baseline.tools.length} 个）：${baseline.tools.join(', ')}\n`)
for (const g of groups) {
  console.log(`${g.ok ? '✓' : '✗'} 工具组 ${g.group} → ${(g.rows as string[]).join(', ')}：少了 ${(g.expectedGone as string[]).join('、')}；` +
    `${(g.stillThere as string[]).length > 0 ? `还在的：${(g.stillThere as string[]).join('、')}；` : ''}` +
    `${(g.othersMissing as string[]).length > 0 ? `被牵连的：${(g.othersMissing as string[]).join('、')}；` : '别的组没被牵连；'}` +
    `${g.started ? 'dsh 正常启动' : `dsh 没起来：${g.error}`}`)
}
console.log()
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}`)
console.log(`\n${allOk ? '全部符合预期' : '有不符合预期的项'}；报告：${join(dir, 'template-probe.json')}`)
process.exit(allOk ? 0 : 1)
