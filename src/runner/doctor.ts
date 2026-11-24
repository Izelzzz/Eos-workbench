// 启动检查：平台进程所在的机器能不能跑任务。eos doctor 列出全部检查；会调用模型的命令启动前跑同样的检查：
// 有 ✗（缺了就一定跑不起来：API key、git、数据目录、dsh）就不启动；只有 ⚠（Node 版本低于声明的要求，实际可能能跑）时提示后照常启动。
// 检查的是平台进程自己（Node、环境变量、git、数据目录、dsh），部署到服务器上时检查的就是服务器。
import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { dshInstall } from '../executor/dsh.ts'

/** ok：满足；warn：不满足但可能还能跑，只提示；fail：缺了一定跑不起来，启动前拦下。 */
export type Status = 'ok' | 'warn' | 'fail'
export type Item = { name: string; status: Status; detail: string; fix?: string }

/** 收集到的事实。evaluate 只看它，不做 IO，可单测。 */
export type Facts = {
  node: string
  /** Eos 的 package.json 里 engines.node，例如 ">=24.9.0"；读不出来时是 undefined。 */
  nodeRequired?: string
  apiKey: boolean
  /** git 的版本号，或者 git 找不到、运行失败的原因。 */
  git: { version: string } | { missing: true } | { error: string }
  dataDir: string
  /** 数据目录建不出来或不可写时的错误。 */
  dataDirError?: string
  /** dsh 的版本；没装时是 undefined。 */
  dsh?: string
}

const parts = (v: string): number[] => v.replace(/^v/, '').split('.').map(x => Number.parseInt(x, 10) || 0)

/** a ≥ b（按主、次、修订号比较）。 */
export const atLeast = (a: string, b: string): boolean => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return true
}

const nodeItem = (f: Facts): Item => {
  if (f.nodeRequired === undefined) return { name: 'Node', status: 'warn', detail: `${f.node}；读不出 Eos 的 package.json 里的 engines.node`, fix: '在仓库目录重新拉取代码，确认 package.json 完整' }
  const min = /^>=\s*(\d+(\.\d+){0,2})$/.exec(f.nodeRequired.trim())?.[1]
  if (min === undefined) return { name: 'Node', status: 'warn', detail: `${f.node}；认不出 engines.node 的写法「${f.nodeRequired}」，没法判断版本够不够`, fix: '把 package.json 的 engines.node 写成 ">=主.次.修订" 的形式' }
  return atLeast(f.node, min)
    ? { name: 'Node', status: 'ok', detail: `${f.node}（要求 ${f.nodeRequired}）` }
    : { name: 'Node', status: 'warn', detail: `${f.node}，低于 Eos 要求的 ${f.nodeRequired}（package.json 的 engines，和 dsh 声明的要求一致）；照常启动，但可能遇到兼容问题`, fix: `安装 Node ${min} 或更新的版本，再用它启动平台` }
}

export const evaluate = (f: Facts): Item[] => [
  nodeItem(f),
  f.apiKey
    ? { name: 'DeepSeek API key', status: 'ok', detail: '已设置环境变量 DEEPSEEK_API_KEY（只检查是否设置，不检查是否有效）' }
    : { name: 'DeepSeek API key', status: 'fail', detail: '没有设置环境变量 DEEPSEEK_API_KEY', fix: '在启动平台的环境里设置 DEEPSEEK_API_KEY=<你的 key>（命令行里 export，或写进服务的环境配置）' },
  'version' in f.git
    ? { name: 'git', status: 'ok', detail: f.git.version }
    : 'missing' in f.git
      ? { name: 'git', status: 'fail', detail: '找不到 git 命令', fix: '安装 git，并确认它在平台进程的 PATH 里' }
      : { name: 'git', status: 'fail', detail: `git 运行失败：${f.git.error}`, fix: '在平台所在的机器上运行 git --version，按报错修好 git' },
  f.dataDirError === undefined
    ? { name: '数据目录', status: 'ok', detail: `${f.dataDir} 可写` }
    : { name: '数据目录', status: 'fail', detail: `${f.dataDir}：${f.dataDirError}`, fix: '用 --data <目录> 或环境变量 EOS_HOME 换一个平台进程能写的目录，或修改这个目录的权限' },
  f.dsh === undefined
    ? { name: 'dsh', status: 'fail', detail: '没有安装，或安装不完整', fix: '在仓库目录运行 npm install' }
    : { name: 'dsh', status: 'ok', detail: f.dsh },
]

/** 数据目录建不出来、不可写时，常见的错误码给中文说明，原始错误码放在括号里。 */
const DIR_ERRORS: Record<string, string> = {
  EACCES: '没有写权限', EPERM: '没有权限', EROFS: '所在的文件系统是只读的', ENOTDIR: '路径里有一段不是目录（是普通文件）', EEXIST: '已经有同名的文件', ENOSPC: '磁盘空间不足',
}

const dataDirError = (dir: string): string | undefined => {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return undefined
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code !== undefined && DIR_ERRORS[code] !== undefined ? `${DIR_ERRORS[code]}（${code}）` : `无法使用（${(e as Error).message}）`
  }
}

const gitState = (): Facts['git'] => {
  try {
    const out = execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { version: /\d+\.\d+(\.\d+)?/.exec(out)?.[0] ?? out.trim() }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    return { error: String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim().split('\n')[0]! }
  }
}

const pkgSchema = z.object({ engines: z.object({ node: z.string() }).partial().optional() })

/** Eos 的 package.json 里 engines.node。文件坏了或没有这一项时是 undefined，由检查项报出来。 */
const nodeRequired = (root: string): string | undefined => {
  try {
    return pkgSchema.safeParse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).data?.engines?.node
  } catch {
    return undefined
  }
}

/** 收集事实。root 是仓库目录（package.json 和 node_modules 所在）。会建出数据目录（和别的命令一样）。 */
export const gather = (o: { root: string; dataDir: string; env: NodeJS.ProcessEnv }): Facts => {
  const required = nodeRequired(o.root)
  const dsh = dshInstall(o.root)?.version
  const error = dataDirError(o.dataDir)
  return {
    node: process.versions.node, ...(required === undefined ? {} : { nodeRequired: required }), apiKey: (o.env.DEEPSEEK_API_KEY ?? '').trim() !== '',
    git: gitState(), dataDir: o.dataDir, ...(error === undefined ? {} : { dataDirError: error }), ...(dsh === undefined ? {} : { dsh }),
  }
}

const MARK: Record<Status, string> = { ok: '✓', warn: '⚠', fail: '✗' }

export const formatItems = (items: Item[]): string =>
  items.map(i => `${MARK[i.status]} ${i.name}：${i.detail}${i.status === 'ok' || i.fix === undefined ? '' : `\n  怎么修：${i.fix}`}`).join('\n')
