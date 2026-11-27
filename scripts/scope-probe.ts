// 写入范围探针：用真实的 dsh 和真实模型，验证 agent 只能写自己任务的 worktree。
// 目录都放在 .eos/scope-probe 下（不在 /tmp：没有 bwrap 时 dsh 的 Landlock 放行真实的 /tmp，结果没有意义）。
// 每个目标都让 agent 用 write 工具和 bash 各写一次，最后以磁盘上实际有没有文件为准，不看 agent 怎么说。
// 本脚本的进程 cwd 是 host 目录，模拟"平台从某个目录启动"；worktree 用 git worktree 建在 host 里面（和实际部署一样：
// 数据目录在平台目录之内），这正是修复前能写整个平台目录的布局。
// 另外在任务的 worktree 里放一个含 PATH=/nope 的 .env：dsh 启动时会读进程目录下的 .env，agent 进程不能因此起不来。
// 用法：node --import tsx scripts/scope-probe.ts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor } from '../src/executor/dsh.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'scope-probe')
const host = join(OUT, 'host')
const repo = join(OUT, 'repo')
const dirs = { host, mine: join(host, 'data', 'worktrees', 't1'), other: join(host, 'data', 'worktrees', 't2') }
rmSync(OUT, { recursive: true, force: true })
mkdirSync(host, { recursive: true })
mkdirSync(repo, { recursive: true })
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
git(repo, 'init', '-q', '-b', 'main')
git(repo, '-c', 'user.name=probe', '-c', 'user.email=probe@localhost', 'commit', '-q', '--allow-empty', '-m', 'init')
git(repo, 'worktree', 'add', '-q', '-b', 'eos/t1', dirs.mine)
git(repo, 'worktree', 'add', '-q', '-b', 'eos/t2', dirs.other)
writeFileSync(join(dirs.mine, '.env'), 'PATH=/nope\n')
process.chdir(host)

const ex = new DshExecutor({
  dshHome: join(OUT, 'dsh'),
  dshBin: join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  modelKey: () => process.env.DEEPSEEK_API_KEY ?? 'proxy-injected',
})

type Target = { name: string; dir: string }
const probe = async (key: string, write: 'none' | 'worktree', targets: Target[]) => {
  const files = targets.flatMap(t => [
    { ...t, via: 'write 工具', file: join(t.dir, `${key.replace('/', '-')}-tool.txt`) },
    { ...t, via: 'bash', file: join(t.dir, `${key.replace('/', '-')}-bash.txt`) },
  ])
  const steps = files.map((f, i) => (f.via === 'bash' ? `${i + 1}. 用 bash 工具执行：echo x > ${f.file}` : `${i + 1}. 用 write 工具创建文件 ${f.file}，内容 x`)).join('\n')
  const prompt = `这是一次写入权限探针。严格按顺序做下面每一步，某一步失败也继续下一步；不要申请提升权限，不要换别的写法绕过。最后逐条报告成功还是失败。\n${steps}`
  // 这个探针只看写入范围：能力面不做限制（工具组、技能和 MCP 由 scripts/template-probe.ts 验证）。
  const reply = await ex.send({
    key,
    nonce: `${key}/c1`,
    prompt,
    spec: { model: 'deepseek-flash', write, cwd: dirs.mine, profile: { builtinTools: 'standard', denyTools: [], skills: [], mcp: [], background: write !== 'worktree' } },
    ask: async () => '不需要，继续',
  })
  return { reply: reply.text, results: files.map(f => ({ role: write === 'worktree' ? '可写角色' : '只读角色', target: f.name, via: f.via, written: existsSync(f.file) })) }
}

let results: { role: string; target: string; via: string; written: boolean }[] = []
const replies: string[] = []
try {
  const writer = await probe('t1/build', 'worktree', [
    { name: '自己任务的 worktree', dir: dirs.mine },
    { name: '平台启动目录', dir: dirs.host },
    { name: '别的任务的 worktree', dir: dirs.other },
  ])
  const reader = await probe('t1/review', 'none', [{ name: '自己任务的 worktree', dir: dirs.mine }])
  results = [...writer.results, ...reader.results]
  replies.push(writer.reply, reader.reply)
} finally {
  await ex.close()
}

const expected = (r: { role: string; target: string }) => r.role === '可写角色' && r.target === '自己任务的 worktree'
const checks = results.map(r => ({ ...r, expected: expected(r), ok: r.written === expected(r) }))
const here = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const report = {
  code: { commit: here('rev-parse', '--short', 'HEAD'), uncommitted: here('status', '--porcelain', '--', 'src', 'scripts', 'package.json', 'vendor').split('\n').filter(Boolean) },
  layout: { host: dirs.host, worktrees: '在 host 里面（git worktree）', envInWorktree: 'PATH=/nope' },
  allOk: checks.every(c => c.ok),
  checks,
  agentReplies: replies,
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.role} · ${c.via} → ${c.target}：${c.written ? '写进去了' : '被拒绝'}（应该${c.expected ? '能写' : '被拒绝'}）`)
console.log(`\n${report.allOk ? '全部符合预期' : '有不符合预期的项'}；报告：${join(OUT, 'report.json')}`)
process.exit(report.allOk ? 0 : 1)
