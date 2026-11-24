// 主密钥不进平台子进程的证据：带着 EOS_MASTER_KEY 跑一遍真实模型的 E2E（npm run e2e），同时每 50ms 扫一遍 /proc，
// 记下每个进程的父进程和环境里有没有主密钥。按祖先链分类：
// - platform：平台进程自己（src/cli.ts）。/proc 里的 environ 是启动时的环境，读出后删掉也改不了它（已知，见 doctor 的"凭据隔离"）；
// - launcher：平台进程的启动器在平台代码运行之前起的子进程（tsx 的 esbuild 服务），和 platform 同一类暴露；
// - leak：祖先里有平台进程的其他进程（dsh、git、检查命令……）。期望为空；
// - driver：E2E 驱动脚本自己和它直接起的进程（建示例仓库的 git、最后核对的 npm test），不是平台起的，不算。
// 局限：按间隔采样，活不到一个间隔的短命进程（例如一次 git rev-parse）可能看不到；子进程继承环境由 credentials.test.ts 确定性地验证。
// 结果写到 .eos/master-key-probe/report.json。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'master-key-probe')
mkdirSync(OUT, { recursive: true })
const key = randomBytes(32).toString('base64')
type Proc = { pid: number; ppid: number; cmd: string; hasKey: boolean }
const procs = new Map<number, Proc>()

const scan = () => {
  for (const name of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    const pid = Number(name)
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim().slice(0, 200)
      const hasKey = readFileSync(`/proc/${pid}/environ`, 'utf8').includes(key)
      const prev = procs.get(pid)
      // pid 可能被复用：命令行变了就当成新进程。
      if (prev === undefined || prev.cmd !== cmd) procs.set(pid, { pid, ppid, cmd, hasKey })
      else prev.hasKey ||= hasKey
    } catch { /* 进程已经退出或读不了 */ }
  }
}

const isPlatform = (p: Proc) => /src\/cli\.ts/.test(p.cmd)
const ancestors = (p: Proc): Proc[] => {
  const out: Proc[] = []
  for (let q = procs.get(p.ppid); q !== undefined && out.length < 64; q = procs.get(q.ppid)) out.push(q)
  return out
}
const classify = (p: Proc): 'platform' | 'launcher' | 'leak' | 'driver' => {
  if (isPlatform(p)) return 'platform'
  const up = ancestors(p)
  if (!up.some(isPlatform)) return 'driver'
  return /esbuild --service/.test(p.cmd) && isPlatform(up[0]!) ? 'launcher' : 'leak'
}

const finish = (code: number | null, error?: string) => {
  clearInterval(timer)
  scan()
  const all = [...procs.values()]
  const underPlatform = all.filter(p => !isPlatform(p) && ancestors(p).some(isPlatform))
  const holders = all.filter(p => p.hasKey).map(p => ({ class: classify(p), cmd: p.cmd }))
  const leaks = holders.filter(h => h.class === 'leak')
  const report = {
    e2eExit: code, ...(error === undefined ? {} : { error }), holders, leaks,
    platformChildrenSeen: underPlatform.length,
    platformChildrenSample: [...new Set(underPlatform.map(p => p.cmd.replace(/\s.*/, '')))],
    dshSeen: underPlatform.filter(p => /dsh/.test(p.cmd)).length,
    checkCommandsSeen: underPlatform.filter(p => /npm test|node --test/.test(p.cmd)).length,
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`\n主密钥探针：E2E 退出码 ${code}；平台起的子进程看到 ${underPlatform.length} 个（dsh ${report.dshSeen}，检查命令 ${report.checkCommandsSeen}），其中带主密钥的 ${leaks.length} 个\n`)
  process.exit(code === 0 && leaks.length === 0 && underPlatform.length > 0 ? 0 : 1)
}

const timer = setInterval(scan, 50)
const child = spawn('npm', ['run', 'e2e'], { cwd: ROOT, env: { ...process.env, EOS_MASTER_KEY: key }, stdio: 'inherit' })
child.on('exit', code => finish(code))
child.on('error', e => finish(null, e.message))
