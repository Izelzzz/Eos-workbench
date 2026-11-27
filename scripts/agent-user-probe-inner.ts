// 由 agent-user-probe.ts 在容器里以平台的身份运行（eos，带着 SETUID、SETGID、KILL，和 deploy/eos 启动平台时一样）。不调用模型。
// 用平台真正的 DshExecutor 打开会话（设工作目录、切换权限档位，都不调用模型），核对：
// - dsh 以 eos-agent 运行，没有能力；平台以 eos-agent 读得到它 0700 的会话日志；
// - 换模型 key 后平台关掉旧 dsh、起新 dsh（#65 的重启路径），新 dsh 也是 eos-agent，旧进程确实结束了（要用到 KILL）；
// - 以 eos-agent 和 eos-check 扫描别的进程的环境（scripts/check-user-scan.mjs）；
// - 撤销越界改动前，agent 留在 worktree 里的进程以 eos-agent 的身份被结束；
// - 升级前留下的会话（argv[2] 给出 key）迁移后能续接。
// 输出一行 JSON。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor, dshEntry, SESSION_LOG_FILE, sessionIdFor } from '../src/executor/dsh.ts'
import { AGENT_USER_ENV, asUser, killUserProcessesIn, readSessionLogAs, resolveCheckUser } from '../src/runner/check-user.ts'

const ROOT = join(import.meta.dirname, '..')
const SCAN = join(import.meta.dirname, 'check-user-scan.mjs')
const data = process.env.EOS_HOME ?? '/data'
const upgradeKey = process.argv[2]
const agent = resolveCheckUser(process.env, undefined, AGENT_USER_ENV)
const check = resolveCheckUser(process.env)
if (agent.kind !== 'ok' || check.kind !== 'ok') throw new Error(`用户没有设置好：${JSON.stringify({ agent, check })}`)

const worktree = join(data, 'worktrees', 'agent-probe')
mkdirSync(worktree, { recursive: true })
const status = (pid: number) => {
  try {
    const s = readFileSync(`/proc/${pid}/status`, 'utf8')
    return Object.fromEntries([...s.matchAll(/^(Uid|CapEff|CapAmb|NoNewPrivs):\s*(\S+)/gm)].map(m => [m[1], m[2]]))
  } catch {
    return 'gone'
  }
}
const dshPids = () => spawnSync('pgrep', ['-f', '@deepseek-ai/[d]sh/lib/bin.js'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number)

let key = 'sk-probe-key-one'
const ex = new DshExecutor({
  dshHome: join(data, 'dsh'),
  dshBin: dshEntry(process.env, ROOT)!,
  modelKey: () => key,
  readSessionLog: readSessionLogAs(agent.user, SESSION_LOG_FILE),
})
const spec = { model: 'deepseek-flash', write: 'worktree' as const, cwd: worktree, profile: { builtinTools: 'standard', denyTools: [], skills: [], mcp: [], background: true } }
// 打开会话：平台每次调用前都走这一步（session 是私有方法，探针直接调用，不发提示词）。
const open = (k: string) => (ex as unknown as { session: (key: string, s: typeof spec) => Promise<unknown> }).session(k, spec)
const raw = (id: string) => (ex as unknown as { rawLog: (id: string) => Buffer | undefined }).rawLog(id)

await open(`${worktree}/probe`)
const first = dshPids()
const firstStatus = Object.fromEntries(first.map(p => [p, status(p)]))
const sessionDirs = execFileSync('sh', ['-c', 'ls -ld "$1"/dsh "$1"/dsh/sessions 2>&1; ls -l "$1"/dsh/sessions 2>&1 | head -5', 'sh', data], { encoding: 'utf8' }).trim().split('\n')
// dsh 写会话日志是异步的：打开会话之后最多等 5 秒（平台实际读日志是在一轮结束之后，或下一次打开时）。
const logWait = Date.now()
let logReadable = false
while (!logReadable && Date.now() - logWait < 5000) {
  logReadable = raw(sessionIdFor(`${worktree}/probe`)) !== undefined
  if (!logReadable) await new Promise(r => setTimeout(r, 100))
}
const logReadAfterMs = Date.now() - logWait
const sessionsAsAgent = (() => {
  const [c, ...a] = asUser(agent.user, ['sh', '-c', 'find "$1" -maxdepth 3 -printf "%M %u:%g %p\\n" | sort', 'sh', join(data, 'dsh', 'sessions')])
  return spawnSync(c!, a, { encoding: 'utf8' }).stdout.trim().split('\n')
})()
const logReadableDirectly = (() => {
  try {
    execFileSync('sh', ['-c', 'cat "$1"/dsh/sessions/*/*/session.v4.jsonl.zstd > /dev/null', 'sh', data], { stdio: 'pipe' })
    return 'ok'
  } catch (e) {
    return String((e as { stderr?: Buffer }).stderr ?? '')
      .trim()
      .split('\n')[0]
  }
})()

// 扫描：dsh 在跑（环境里有模型 key）。eos-agent 在沙箱外（代表 dsh 起的 MCP 服务、或者沙箱失效时的 agent），eos-check（代表检查命令）。
const scanAs = (u: { name: string; gid: number; home: string }) => {
  const [cmd, ...args] = asUser(u, ['node', SCAN])
  return JSON.parse(execFileSync(cmd!, args, { cwd: '/tmp', encoding: 'utf8' }).trim().split('\n').at(-1)!)
}
const pick = (s: { uid: number; caps: unknown; secretsFoundIn: unknown; processes: { pid: number; uid: number; cmdline: string; environ: string }[] }) => ({
  uid: s.uid,
  caps: s.caps,
  secretsFoundIn: s.secretsFoundIn,
  environ: s.processes.map(p => ({ pid: p.pid, uid: p.uid, cmdline: p.cmdline, environ: p.environ })),
})
const asAgent = pick(scanAs(agent.user))
const asCheck = pick(scanAs(check.user))

// 换 key：平台关掉旧 dsh（它属于 eos-agent，要用 KILL 能力发信号），起新 dsh。
key = 'sk-probe-key-two'
await open(`${worktree}/probe-after-key-change`)
await new Promise(r => setTimeout(r, 1000))
const second = dshPids()
const restart = {
  before: first,
  after: second,
  oldGone: first.every(p => status(p) === 'gone'),
  afterStatus: Object.fromEntries(second.map(p => [p, status(p)])),
}

// eos-agent（代表 dsh 在沙箱外起的 MCP 服务）想让平台顺着链接写到别处（独立审查发现的）：
// 把平台的目录改名再换成链接、往平台的目录里放链接、删掉平台写的文件。都应该被拒绝。
const attack = (script: string) => {
  const [c, ...a] = asUser(agent.user, ['sh', '-c', script, 'sh', join(data, 'dsh')])
  const r = spawnSync(c!, a, { encoding: 'utf8' })
  return r.status === 0 ? 'ok' : r.stderr.trim().split('\n')[0]
}
const symlinkAttack = {
  renameProfilesDir: attack('mv "$1/eos-profiles" "$1/moved"'),
  plantLinkInProfiles: attack('ln -s /data "$1/eos-profiles/planted"'),
  replacePatchFile: attack('f=$(ls "$1"/eos-profiles/*/cordis.patch.yml | head -1); rm -f "$f" && ln -s /data/eos.db "$f"'),
  renameProcessCwd: attack('mv "$1/eos-process-cwd" "$1/moved2"'),
  // 反过来：MCP 服务（eos-agent）要能在自己的工作目录里写。
  mcpWritesItsCwd: attack('touch "$1/mcp-cwd/cache-file" && rm "$1/mcp-cwd/cache-file"'),
  modes: execFileSync('sh', ['-c', 'stat -c "%A %U:%G %n" "$1" "$1"/eos-profiles "$1"/eos-profiles/* "$1"/eos-process-cwd "$1"/mcp-cwd', 'sh', join(data, 'dsh')], { encoding: 'utf8' })
    .trim()
    .split('\n'),
}

// agent 留下的进程：以 eos-agent 在 worktree 里起一个脱离进程组的 sleep，平台撤销前以 eos-agent 的身份结束它。
const [lc, ...la] = asUser(agent.user, ['setsid', 'sleep', '300'])
const leftover = spawn(lc!, la, { cwd: worktree, detached: true, stdio: 'ignore' })
await new Promise(r => setTimeout(r, 500))
const killed = await killUserProcessesIn(agent.user, worktree)
await new Promise(r => setTimeout(r, 300))

// 升级前（dsh 以 eos 运行）留下的会话：迁移后用同一个 key 打开，走的是续接（resumeSession）。
let upgrade: unknown = 'skipped'
if (upgradeKey !== undefined && upgradeKey !== '') {
  const oldCwd = join(data, 'worktrees', 'upgrade-task')
  const id = sessionIdFor(upgradeKey)
  const before = raw(id) !== undefined
  try {
    await (ex as unknown as { session: (key: string, s: typeof spec) => Promise<unknown> }).session(upgradeKey, { ...spec, cwd: oldCwd })
    upgrade = { logFoundAfterMigration: before, resumed: 'ok' }
  } catch (e) {
    upgrade = { logFoundAfterMigration: before, resumed: (e as Error).message }
  }
}

await ex.close()
await new Promise(r => setTimeout(r, 1000))
console.log(
  JSON.stringify({
    platform: status(process.pid),
    agentUser: agent.user.name,
    firstDsh: firstStatus,
    sessionDirs,
    platformReadsLogAsAgent: logReadable,
    logReadAfterMs,
    sessionsAsAgent,
    platformReadsLogDirectly: logReadableDirectly,
    restartAfterKeyChange: restart,
    scanAsAgentOutsideSandbox: asAgent,
    scanAsCheckUser: asCheck,
    symlinkAttack,
    leftover: { pid: leftover.pid, killed, gone: status(leftover.pid!) === 'gone' },
    upgrade,
    dshAfterClose: dshPids(),
  }),
)
