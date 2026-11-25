// 由 check-user-probe.ts 在容器里运行：作为检查命令执行，报告这个进程能读到、能写、能切换到什么。
// 输出一行 JSON。只报告找到的变量名和进程，不输出变量的值。
import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const WATCH = ['EOS_MASTER_KEY', 'DEEPSEEK_API_KEY']
const status = readFileSync('/proc/self/status', 'utf8')
const field = name => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim()

const procs = []
for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
  let uid, ppid, comm, capEff, capAmb, cmdline
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8')
    uid = /^Uid:\s*(\d+)/m.exec(st)?.[1]
    ppid = /^PPid:\s*(\d+)/m.exec(st)?.[1]
    capEff = /^CapEff:\s*(\S+)/m.exec(st)?.[1]
    capAmb = /^CapAmb:\s*(\S+)/m.exec(st)?.[1]
    comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
    // 命令行所有用户都能读；只留前两段（程序和脚本），不带参数。
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 2).join(' ')
  } catch { continue }
  let vars, environ = 'readable'
  try { vars = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0') } catch (e) { environ = e.code }
  const found = vars === undefined ? [] : WATCH.filter(k => vars.some(v => v.startsWith(`${k}=`) && v.length > k.length + 1))
  procs.push({ pid: Number(pid), ppid: Number(ppid), uid: Number(uid), comm, cmdline, capEff, capAmb, environ, found })
}

const tryRun = (cmd, args) => {
  try { execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); return 'ok' } catch (e) { return String(e.stderr ?? e.message).trim().split('\n')[0] }
}
const tryRename = (from, to) => {
  try { renameSync(from, to); renameSync(to, from); return 'ok' } catch (e) { return e.code }
}
const tryWrite = (path, append = false) => {
  try { (append ? appendFileSync : writeFileSync)(path, ''); return 'ok' } catch (e) { return e.code }
}

const tryRead = path => {
  try { readFileSync(path); return 'ok' } catch (e) { return e.code }
}

const [, , worktreeFile, ...forbidden] = process.argv
console.log(JSON.stringify({
  uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(), home: process.env.HOME,
  caps: { inheritable: field('CapInh'), permitted: field('CapPrm'), effective: field('CapEff'), ambient: field('CapAmb') },
  noNewPrivs: field('NoNewPrivs'),
  envHasSecrets: WATCH.filter(k => process.env[k] !== undefined),
  secretsFoundIn: procs.filter(p => p.found.length > 0).map(p => ({ pid: p.pid, uid: p.uid, comm: p.comm, found: p.found })),
  processes: procs.map(({ found: _found, ...p }) => p),
  switchToRoot: tryRun('setpriv', ['--reuid=0', '--regid=0', '--clear-groups', 'true']),
  switchToEos: tryRun('setpriv', ['--reuid=eos', '--regid=eos', '--clear-groups', 'true']),
  // 把自己任务的 worktree 目录改名（在 worktrees 目录里改名，和替换别的任务的 worktree 需要同样的权限）。
  renameWorktreeDir: worktreeFile === undefined ? 'skipped' : tryRename(dirname(worktreeFile), join(dirname(dirname(worktreeFile)), 'renamed-by-check')),
  writeTrackedFileInWorktree: worktreeFile === undefined ? 'skipped' : tryWrite(worktreeFile, true),
  writeOutsideWorktree: Object.fromEntries(forbidden.map(p => [p, tryWrite(p, true)])),
  readOutsideWorktree: Object.fromEntries(forbidden.map(p => [p, tryRead(p)])),
}))
