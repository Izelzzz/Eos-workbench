// 由 check-user-probe.ts 在容器里运行：作为检查命令执行，报告这个进程能读到、能写、能切换到什么。
// 输出一行 JSON。只报告找到的变量名和进程，不输出变量的值。
import { execFileSync } from 'node:child_process'
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

const WATCH = ['EOS_MASTER_KEY', 'DEEPSEEK_API_KEY']
const status = readFileSync('/proc/self/status', 'utf8')
const field = name => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim()

const procs = []
for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
  let uid, comm
  try {
    uid = /^Uid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]
    comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
  } catch { continue }
  let vars, environ = 'readable'
  try { vars = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0') } catch (e) { environ = e.code }
  const found = vars === undefined ? [] : WATCH.filter(k => vars.some(v => v.startsWith(`${k}=`) && v.length > k.length + 1))
  procs.push({ pid: Number(pid), uid: Number(uid), comm, environ, found })
}

const tryRun = (cmd, args) => {
  try { execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); return 'ok' } catch (e) { return String(e.stderr ?? e.message).trim().split('\n')[0] }
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
  processes: procs.map(({ pid, uid, comm, environ }) => ({ pid, uid, comm, environ })),
  switchToRoot: tryRun('setpriv', ['--reuid=0', '--regid=0', '--clear-groups', 'true']),
  switchToEos: tryRun('setpriv', ['--reuid=eos', '--regid=eos', '--clear-groups', 'true']),
  writeTrackedFileInWorktree: worktreeFile === undefined ? 'skipped' : tryWrite(worktreeFile, true),
  writeOutsideWorktree: Object.fromEntries(forbidden.map(p => [p, tryWrite(p, true)])),
  readOutsideWorktree: Object.fromEntries(forbidden.map(p => [p, tryRead(p)])),
}))
