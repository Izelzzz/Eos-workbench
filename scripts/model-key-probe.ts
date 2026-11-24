// 模型 key 取自凭据存储、dsh 环境是白名单的证据：把一个随机生成的 key 只放进凭据存储（平台进程环境里没有 DEEPSEEK_API_KEY），
// 跑一遍真实模型的 E2E（npm run e2e），同时每 50ms 扫一遍 /proc，记下平台起的每个子进程的环境：
// - dsh 进程：环境变量的名字是否都在白名单里，DEEPSEEK_API_KEY 是否等于凭据存储里的值；
// - 其余子进程（git、检查命令、agent 的工具命令）：环境里不应该有这个 key。
// 跑完后用同一个数据目录运行 eos doctor，看 key 的来源；再在数据目录的所有文件里查找 key 的明文。
// 这个容器的代理会替换发往 api.deepseek.com 的 key，所以随机值也能调通模型：能证明 dsh 拿到的 key 来自凭据存储，证明不了存进去的值本身有效。
// 结果写到 .eos/model-key-probe/report.json。
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentEnvAllowed } from '../src/executor/dsh.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'model-key-probe')
const DATA = join(ROOT, '.eos', 'e2e', 'data')
mkdirSync(OUT, { recursive: true })
const masterKey = randomBytes(32).toString('base64')
const storeKey = `sk-eos-store-${randomBytes(16).toString('hex')}`

type Proc = { pid: number; ppid: number; cmd: string; names: Set<string>; dshKey?: string; hasKey: boolean }
const procs = new Map<number, Proc>()

const scan = () => {
  for (const name of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    const pid = Number(name)
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim().slice(0, 200)
      const vars = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(v => v !== '')
      const names = new Set(vars.map(v => v.slice(0, v.indexOf('='))))
      const dshKey = vars.find(v => v.startsWith('DEEPSEEK_API_KEY='))?.slice('DEEPSEEK_API_KEY='.length)
      const hasKey = vars.some(v => v.includes(storeKey))
      const prev = procs.get(pid)
      if (prev === undefined || prev.cmd !== cmd) procs.set(pid, { pid, ppid, cmd, names, ...(dshKey === undefined ? {} : { dshKey }), hasKey })
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
/** dsh 进程：父进程是平台进程、命令行里是 dsh 的启动文件。agent 的工具命令是 dsh 的子孙，不算。 */
const isDsh = (p: Proc) => p.cmd.includes('@deepseek-ai/dsh/lib/bin.js') && procs.get(p.ppid) !== undefined && isPlatform(procs.get(p.ppid)!)
const allowed = (n: string) => agentEnvAllowed(n) || n === 'DEEPSEEK_API_KEY'

const finish = (code: number | null, error?: string) => {
  clearInterval(timer)
  scan()
  const all = [...procs.values()]
  const platform = all.filter(isPlatform)
  const children = all.filter(p => !isPlatform(p) && ancestors(p).some(isPlatform))
  const dsh = children.filter(isDsh)
  const others = children.filter(p => !isDsh(p))
  const doctor = (() => {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, EOS_MASTER_KEY: masterKey }
      delete env.DEEPSEEK_API_KEY
      return execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'doctor', '--data', DATA], { cwd: ROOT, env, encoding: 'utf8' })
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? e)
    }
  })()
  const plaintextFiles = (readdirSync(DATA, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
    .filter(d => d.isFile()).map(d => join(d.parentPath, d.name)).filter(f => readFileSync(f).includes(storeKey)).map(f => f.slice(DATA.length + 1))
  const report = {
    e2eExit: code, ...(error === undefined ? {} : { error }),
    platformProcesses: platform.length,
    platformEnvHasModelKey: platform.some(p => p.names.has('DEEPSEEK_API_KEY')),
    platformWithModelKey: platform.filter(p => p.names.has('DEEPSEEK_API_KEY')).map(p => p.cmd),
    dsh: dsh.map(p => ({ cmd: p.cmd, envNames: [...p.names].sort(), notAllowed: [...p.names].filter(n => !allowed(n)), keyFromStore: p.dshKey === storeKey })),
    otherChildrenSeen: others.length,
    otherChildrenSample: [...new Set(others.map(p => p.cmd.replace(/\s.*/, '')))],
    otherChildrenWithKey: others.filter(p => p.hasKey || p.names.has('DEEPSEEK_API_KEY')).map(p => p.cmd),
    doctor,
    plaintextFiles,
  }
  const checks = {
    'E2E 通过': code === 0,
    '平台进程的环境里没有 DEEPSEEK_API_KEY': platform.length > 0 && !report.platformEnvHasModelKey,
    '看到了 dsh 进程': dsh.length > 0,
    '每个 dsh 进程的 DEEPSEEK_API_KEY 都等于凭据存储里的值': dsh.length > 0 && dsh.every(p => p.dshKey === storeKey),
    'dsh 进程的环境变量都在白名单里': dsh.every(p => [...p.names].every(allowed)),
    '其他子进程（git、检查命令、工具命令）的环境里没有这个 key': others.length > 0 && report.otherChildrenWithKey.length === 0,
    'eos doctor 显示 key 来自凭据存储': /✓ DeepSeek API key：来自凭据存储（凭据 deepseek）/.test(doctor),
    '数据目录里没有 key 的明文': plaintextFiles.length === 0,
  }
  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify({ checks, ...report }, null, 2)}\n`)
  process.stdout.write(`\n模型 key 探针：\n${JSON.stringify(checks, null, 2)}\n`)
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
}

const timer = setInterval(scan, 50)
const env: NodeJS.ProcessEnv = { ...process.env, EOS_MASTER_KEY: masterKey, EOS_E2E_STORE_KEY: storeKey }
delete env.DEEPSEEK_API_KEY
const child = spawn('npm', ['run', 'e2e'], { cwd: ROOT, env, stdio: 'inherit' })
child.on('exit', code => finish(code))
child.on('error', e => finish(null, e.message))
