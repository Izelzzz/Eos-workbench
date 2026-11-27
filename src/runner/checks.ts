// 平台执行的验收检查：在任务的 worktree 里看交付物文件、跑命令。结果交给引擎（checked 事件）。
// 命令退出后整个进程组都会被结束：检查命令留下的后台进程（例如没收尾的测试服务）不会一直留着。
//
// 命令检查在 worktree 里执行仓库代码（例如 npm test 会跑 agent 改过的 package.json），和 CI runner 一样不在 agent 的沙箱里。
// 所以只给它最小的环境变量，不传模型密钥等其它变量；部署镜像里还换成独立的用户运行（check-user.ts），
// 读不到平台和执行器进程环境里的主密钥和模型 key。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { CheckResult } from '../engine/types.ts'
import type { Check } from '../workflow/types.ts'
import { asUser, type CheckUser } from './check-user.ts'

/** 命令输出只保留最后这么多字符，交给 agent 和页面。 */
export const OUTPUT_TAIL = 4000

const KEEP_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TZ',
  // 服务器在会解开 TLS 的代理后面时，联网的检查（npm install、pip install）要用到的证书和代理设置。
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
]
/** 代理地址。带账号密码（有 @）的不传：检查命令跑的是 agent 改过的代码。 */
export const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']

/** 设置了、但因为带账号密码没有传给检查命令的代理变量。 */
export const droppedProxies = (env: NodeJS.ProcessEnv): string[] => PROXY_ENV.filter(k => env[k]?.includes('@') === true)

/**
 * 检查命令的环境。user 给定时 HOME 换成它的家目录（平台的家目录它写不了）；
 * worktree 和它的 git 目录属于平台用户，git 默认拒绝在别的用户的仓库里运行（dubious ownership），这里放行。
 */
export const checkEnv = (env: NodeJS.ProcessEnv, user?: CheckUser): NodeJS.ProcessEnv => ({
  ...Object.fromEntries([...KEEP_ENV, ...PROXY_ENV].flatMap(k => (env[k] === undefined || droppedProxies(env).includes(k) ? [] : [[k, env[k]]]))),
  ...(user === undefined ? {} : { HOME: user.home, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }),
  CI: '1',
})

/** Markdown 标题（忽略代码块里的 #）。 */
export const headings = (md: string): string[] => {
  const out: string[] = []
  let fence: string | undefined
  for (const line of md.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (f !== undefined) {
      if (fence === undefined) fence = f[0]
      else if (f[0] === fence) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)?.[1]
    if (h !== undefined && h !== '') out.push(h)
  }
  return out
}

/** 标题里包含章节名就算有（允许"## 1. 背景与目标"这样的写法）。 */
export const missingSections = (md: string, sections: string[]): string[] => {
  const hs = headings(md)
  return sections.filter(s => !hs.some(h => h.includes(s)))
}

const tail = (s: string): string => (s.length <= OUTPUT_TAIL ? s : `…（前面省略 ${s.length - OUTPUT_TAIL} 个字符）\n${s.slice(-OUTPUT_TAIL)}`)

const checkFile = (worktree: string, c: Extract<Check, { kind: 'file' }>): CheckResult => {
  const fail = (detail: string): CheckResult => ({ check: c, passed: false, detail })
  const target = join(worktree, c.path)
  if (!existsSync(target)) return fail(`文件 ${c.path} 不存在`)
  // 路径在解析时已经限制为相对路径；这里再挡住指向 worktree 外面的符号链接。
  const real = realpathSync(target)
  const rel = relative(realpathSync(worktree), real)
  if (rel === '..' || rel.startsWith(`..${sep}`)) return fail(`${c.path} 指向 worktree 外面`)
  if (!statSync(real).isFile()) return fail(`${c.path} 不是文件`)
  const missing = missingSections(readFileSync(real, 'utf8'), c.sections)
  if (missing.length === 0) return { check: c, passed: true, detail: '' }
  const hs = headings(readFileSync(real, 'utf8'))
  return fail(`缺少章节：${missing.join('、')}\n现有标题：${hs.length === 0 ? '（没有标题）' : hs.join('、')}`)
}

/** 命令退出（或超时被杀）之后，最多再等这么久让输出管道关闭；逃出进程组又占着管道的孙进程不会让检查卡住。 */
export const PIPE_GRACE_MS = 2000

const checkRun = (worktree: string, c: Extract<Check, { kind: 'run' }>, env: NodeJS.ProcessEnv, signal?: AbortSignal, user?: CheckUser): Promise<CheckResult> =>
  new Promise(done => {
    let out = ''
    let ended: 'exit' | 'timeout' | 'aborted' | undefined
    let code: number | null = null
    let settled = false
    // 单独的进程组：结束时连同它启动的子进程一起结束。setpriv 切换用户后 exec 命令本身，进程号不变。
    const [cmd, ...args] = user === undefined ? c.run : asUser(user, c.run)
    const p = spawn(cmd!, args, { cwd: worktree, env: checkEnv(env, user), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    // 按 UTF-8 解码，多字节字符跨块时不会乱码。
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    const keep = (chunk: string) => {
      out = (out + chunk).slice(-OUTPUT_TAIL * 2)
    }
    p.stdout.on('data', keep)
    p.stderr.on('data', keep)
    const killGroup = () => {
      if (p.pid === undefined) return
      // 别的用户的进程平台发不了信号（EPERM），以同一个用户去杀。进程组已经没有进程时 kill 报错，不用管。
      if (user !== undefined) {
        const [k, ...kargs] = asUser(user, ['kill', '-KILL', '--', `-${p.pid}`])
        spawn(k!, kargs, { env: checkEnv(env, user), stdio: 'ignore' }).on('error', () => {})
        return
      }
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {
        // 进程组已经没有进程了
      }
    }
    let grace: ReturnType<typeof setTimeout> | undefined
    const finish = (r: CheckResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      signal?.removeEventListener('abort', onAbort)
      p.stdout.destroy()
      p.stderr.destroy()
      done(r)
    }
    const result = (): CheckResult => {
      const output = out.trim() === '' ? '（没有输出）' : tail(out.trim())
      if (ended === 'aborted') return { check: c, passed: false, detail: `任务已中止，命令被终止。输出：\n${output}` }
      if (ended === 'timeout') return { check: c, passed: false, detail: `超过 ${c.timeoutSec} 秒没有结束，已终止。输出：\n${output}` }
      return code === 0 ? { check: c, passed: true, detail: '' } : { check: c, passed: false, detail: `退出码 ${code ?? '（被信号终止）'}。输出：\n${output}` }
    }
    /** 命令结束（正常退出、超时或中止）：清掉进程组里剩下的进程，等管道关闭，但最多等 PIPE_GRACE_MS。 */
    const end = (how: 'exit' | 'timeout' | 'aborted') => {
      if (ended !== undefined) return
      ended = how
      killGroup()
      grace = setTimeout(() => finish(result()), PIPE_GRACE_MS)
    }
    const onAbort = () => end('aborted')
    const timer = setTimeout(() => end('timeout'), c.timeoutSec * 1000)
    if (signal?.aborted) end('aborted')
    else signal?.addEventListener('abort', onAbort, { once: true })
    p.on('error', e => finish({ check: c, passed: false, detail: `无法启动命令：${e.message}` }))
    p.on('exit', exitCode => {
      code = exitCode
      end('exit')
    })
    p.on('close', () => {
      if (ended !== undefined) finish(result())
    })
  })

/** 平台动作由调用方执行（它知道任务的远程仓库和凭据）。 */
export type PlatformRunner = (c: Extract<Check, { kind: 'platform' }>) => Promise<CheckResult>

/**
 * 按顺序执行，结果顺序与 checks 一致。一项失败不影响后面的检查：一次把所有问题都告诉 agent。
 * 平台动作只在前面的检查都通过时才做（例如测试不过就不推送）。
 */
export const runChecks = async (worktree: string, checks: Check[], env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal, platform?: PlatformRunner, user?: CheckUser): Promise<CheckResult[]> => {
  if (!existsSync(worktree)) throw new Error(`worktree 不存在：${worktree}`)
  const results: CheckResult[] = []
  for (const c of checks) {
    if (c.kind === 'file') results.push(checkFile(worktree, c))
    else if (c.kind === 'run') results.push(await checkRun(worktree, c, env, signal, user))
    else if (signal?.aborted === true) results.push({ check: c, passed: false, detail: '任务已中止，这一步没有做' })
    else if (results.some(r => !r.passed)) results.push({ check: c, passed: false, detail: '前面的检查没有通过，这一步没有做' })
    else if (platform === undefined) results.push({ check: c, passed: false, detail: '这里不能执行平台动作' })
    else results.push(await platform(c))
  }
  return results
}
