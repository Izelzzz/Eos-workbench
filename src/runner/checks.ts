// 平台执行的验收检查：在任务的 worktree 里看交付物文件、跑命令。结果交给引擎（checked 事件）。
//
// 命令检查用平台进程的权限在 worktree 里执行仓库代码（例如 npm test 会跑 agent 改过的 package.json），
// 和 CI runner 一样不在 agent 的沙箱里。所以只给它最小的环境变量，不传模型密钥等其它变量。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { CheckResult } from '../engine/types.ts'
import type { Check } from '../workflow/types.ts'

/** 命令输出只保留最后这么多字符，交给 agent 和页面。 */
export const OUTPUT_TAIL = 4000

const KEEP_ENV = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']

export const checkEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(KEEP_ENV.flatMap(k => (env[k] === undefined ? [] : [[k, env[k]]]))),
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

const checkRun = (worktree: string, c: Extract<Check, { kind: 'run' }>, env: NodeJS.ProcessEnv): Promise<CheckResult> =>
  new Promise(done => {
    let out = ''
    let timedOut = false
    // 单独的进程组：超时时连同它启动的子进程一起结束。
    const p = spawn(c.run[0]!, c.run.slice(1), { cwd: worktree, env: checkEnv(env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const keep = (chunk: Buffer) => {
      out = (out + chunk.toString('utf8')).slice(-OUTPUT_TAIL * 2)
    }
    p.stdout.on('data', keep)
    p.stderr.on('data', keep)
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-p.pid!, 'SIGKILL')
      } catch {
        // 进程已经退出
      }
    }, c.timeoutSec * 1000)
    p.on('error', e => {
      clearTimeout(timer)
      done({ check: c, passed: false, detail: `无法启动命令：${e.message}` })
    })
    p.on('close', code => {
      clearTimeout(timer)
      const output = out.trim() === '' ? '（没有输出）' : tail(out.trim())
      if (timedOut) return done({ check: c, passed: false, detail: `超过 ${c.timeoutSec} 秒没有结束，已终止。输出：\n${output}` })
      done(code === 0 ? { check: c, passed: true, detail: '' } : { check: c, passed: false, detail: `退出码 ${code ?? '（被信号终止）'}。输出：\n${output}` })
    })
  })

/** 按顺序执行，结果顺序与 checks 一致。一项失败不影响后面的检查：一次把所有问题都告诉 agent。 */
export const runChecks = async (worktree: string, checks: Check[], env: NodeJS.ProcessEnv = process.env): Promise<CheckResult[]> => {
  if (!existsSync(worktree)) throw new Error(`worktree 不存在：${worktree}`)
  const results: CheckResult[] = []
  for (const c of checks) results.push(c.kind === 'file' ? checkFile(worktree, c) : await checkRun(worktree, c, env))
  return results
}
