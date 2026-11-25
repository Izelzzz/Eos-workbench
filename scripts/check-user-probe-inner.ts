// 由 check-user-probe.ts 在容器里以平台的身份运行（eos 用户，带着 SETUID、SETGID，和 deploy/eos 启动平台时一样）。
// 用平台真正的 runChecks 跑检查命令，对照「以平台用户直接运行」的同一个扫描，结果输出一行 JSON。
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCheckUser } from '../src/runner/check-user.ts'
import { runChecks } from '../src/runner/checks.ts'

const SCAN = join(import.meta.dirname, 'check-user-scan.mjs')
const data = process.env.EOS_HOME ?? '/data'
const repo = join(data, 'repos', 'probe')
const worktree = join(data, 'worktrees', 'probe')
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=probe', '-c', 'user.email=probe@localhost', ...a], { cwd, encoding: 'utf8' })

rmSync(repo, { recursive: true, force: true })
rmSync(worktree, { recursive: true, force: true })
mkdirSync(repo, { recursive: true })
git(repo, 'init', '-q', '-b', 'main')
execFileSync('sh', ['-c', 'echo hello > a.txt'], { cwd: repo })
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'init')
// 和平台建 worktree 一样：在 worktrees 目录（共用组、setgid）下 git worktree add。
git(repo, 'worktree', 'add', '-q', worktree)
const mode = (p: string) => { const s = statSync(p); return { gid: s.gid, mode: (s.mode & 0o7777).toString(8) } }

// 代替 dsh 进程：同一个用户（eos），环境里有模型 key。
const fakeDsh = spawn('sleep', ['600'], { env: { ...process.env, DEEPSEEK_API_KEY: 'sk-probe-not-a-real-key' }, detached: true, stdio: 'ignore' })

// 真的 dsh：经 EOS_DSH_LAUNCHER 启动（和平台一样），stdin 开着，它等着 JSON-RPC，不会调用模型。
// 包装用 process.execve 换成 setpriv 再换成 dsh，进程号不变：等这个进程的命令行变成 dsh。
const capsOf = (pid: number) => Object.fromEntries([...readFileSync(`/proc/${pid}/status`, 'utf8').matchAll(/^(Uid|CapEff|CapAmb|NoNewPrivs):\s*(\S+)/gm)].map(m => [m[1], m[2]]))
const launched = spawn(process.execPath, [process.env.EOS_DSH_LAUNCHER!, '--profile', 'sdk'], {
  env: { ...process.env, DEEPSEEK_API_KEY: 'sk-probe-not-a-real-key', DSH_HOME: join(data, 'dsh-probe') }, stdio: ['pipe', 'ignore', 'ignore'],
})
const cmdlineOf = (pid: number) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 2).join(' ') } catch { return '' } }
for (let i = 0; i < 100 && !cmdlineOf(launched.pid!).includes('@deepseek-ai/dsh/'); i++) await new Promise(r => setTimeout(r, 100))
const realDsh = { pid: launched.pid, cmdline: cmdlineOf(launched.pid!), caps: cmdlineOf(launched.pid!).includes('@deepseek-ai/dsh/') ? capsOf(launched.pid!) : 'dsh 没有起来' }

// 平台调用的 git（镜像里 /usr/local/bin/git 包装）：git 起的子进程不带能力。
const gitCaps = execFileSync('git', ['-c', 'alias.caps=!grep -E "^Cap(Eff|Amb)" /proc/self/status', 'caps'], { cwd: repo, encoding: 'utf8' }).trim().split('\n')

const user = resolveCheckUser(process.env)
if (user.kind !== 'ok') throw new Error(`EOS_CHECK_USER 没有设置好：${JSON.stringify(user)}`)
const forbidden = [join(data, 'eos.db'), join(repo, 'a.txt'), '/home/eos/.bashrc']
/** 扫描结果写到 out（检查命令通过时 runChecks 不带输出）。 */
const scanArgs = (out: string) => ['sh', '-c', 'out="$1"; scan="$2"; shift 2; node "$scan" "$@" > "$out"', 'scan', out, SCAN, join(worktree, 'a.txt'), ...forbidden]

const viaCheckOut = join(worktree, 'scan-check.json')
const [viaCheck] = await runChecks(worktree, [{ kind: 'run', run: scanArgs(viaCheckOut), timeoutSec: 30 }], process.env, undefined, undefined, user.user)
const control = spawnSync('sh', scanArgs(join(data, 'scan-control.json')).slice(1), { encoding: 'utf8' })

// 扫描时真的 dsh 一直在跑；扫完再结束它。
launched.kill('SIGTERM')
const dshExit = await new Promise<{ code: number | null; signal: string | null }>(r => launched.once('exit', (code, signal) => r({ code, signal })))

// 检查命令里跑 git：worktree 和它的 git 目录属于平台用户。
const [gitCheck] = await runChecks(worktree, [{ kind: 'run', run: ['sh', '-c', 'git status --porcelain && git diff --check && git log --oneline -1'], timeoutSec: 30 }], process.env, undefined, undefined, user.user)

// 超时：检查命令和它的子进程要被结束（平台不能直接给 eos-check 的进程发信号）。
const started = Date.now()
const [hung] = await runChecks(worktree, [{ kind: 'run', run: ['sh', '-c', 'sleep 300 & sleep 300'], timeoutSec: 2 }], process.env, undefined, undefined, user.user)
await new Promise(r => setTimeout(r, 500))
// ps -u 找不到进程时退出码是 1。
const leftover = spawnSync('ps', ['-u', user.user.name, '-o', 'pid=,comm='], { encoding: 'utf8' }).stdout.trim()

process.kill(-fakeDsh.pid!, 'SIGKILL')

console.log(JSON.stringify({
  platform: { uid: process.getuid?.(), groups: process.getgroups?.(), caps: /^CapEff:\s*(\S+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] },
  checkUser: user.user,
  // 平台给的 SIGTERM 直接到 dsh，退出时报的就是这个信号。
  realDsh: { ...realDsh, exitAfterSigterm: dshExit },
  gitCaps,
  worktreeDir: mode(join(data, 'worktrees')), worktreeFile: mode(join(worktree, 'a.txt')),
  viaCheck: { result: viaCheck, scan: JSON.parse(readFileSync(viaCheckOut, 'utf8')), outputFile: mode(viaCheckOut) },
  control: { status: control.status, stderr: control.stderr, scan: JSON.parse(readFileSync(join(data, 'scan-control.json'), 'utf8')) },
  gitCheck: { passed: gitCheck?.passed, detail: gitCheck?.detail },
  timeout: { passed: hung?.passed, detail: hung?.detail.split('\n')[0], ms: Date.now() - started, leftoverCheckUserProcesses: leftover === '' ? [] : leftover.split('\n') },
}))
