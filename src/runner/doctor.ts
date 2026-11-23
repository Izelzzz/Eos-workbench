// 启动检查：平台进程所在的机器能不能跑任务。eos doctor 列出全部检查；会调用模型的命令启动前跑同样的检查，不通过就不启动。
// 检查的是平台进程自己（Node、环境变量、git、数据目录、dsh），部署到服务器上时检查的就是服务器。
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Item = { name: string; ok: boolean; detail: string; fix?: string }

/** 收集到的事实。evaluate 只看它，不做 IO，可单测。 */
export type Facts = {
  node: string
  /** package.json 的 engines.node，例如 ">=24.9.0"。 */
  nodeRequired: string
  apiKey: boolean
  /** git --version 的版本号；找不到 git 时是 undefined。 */
  git?: string
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

export const evaluate = (f: Facts): Item[] => {
  const min = /^>=\s*(\d+(\.\d+){0,2})$/.exec(f.nodeRequired.trim())?.[1]
  return [
    min === undefined || atLeast(f.node, min)
      ? { name: 'Node', ok: true, detail: `${f.node}（要求 ${f.nodeRequired}）` }
      : { name: 'Node', ok: false, detail: `${f.node}，低于要求的 ${f.nodeRequired}（dsh 声明的最低版本）`, fix: `安装 Node ${min} 或更新的版本，再用它启动平台` },
    f.apiKey
      ? { name: 'DeepSeek API key', ok: true, detail: '已设置环境变量 DEEPSEEK_API_KEY（只检查是否设置，不检查是否有效）' }
      : { name: 'DeepSeek API key', ok: false, detail: '没有设置环境变量 DEEPSEEK_API_KEY', fix: '在启动平台的环境里设置 DEEPSEEK_API_KEY=<你的 key>（命令行里 export，或写进服务的环境配置）' },
    f.git === undefined
      ? { name: 'git', ok: false, detail: '找不到 git 命令', fix: '安装 git，并确认它在平台进程的 PATH 里' }
      : { name: 'git', ok: true, detail: f.git },
    f.dataDirError === undefined
      ? { name: '数据目录', ok: true, detail: `${f.dataDir} 可写` }
      : { name: '数据目录', ok: false, detail: `${f.dataDir}：${f.dataDirError}`, fix: '用 --data <目录> 或环境变量 EOS_HOME 换一个平台进程能写的目录，或修改这个目录的权限' },
    f.dsh === undefined
      ? { name: 'dsh', ok: false, detail: '没有安装', fix: '在仓库目录运行 npm install' }
      : { name: 'dsh', ok: true, detail: f.dsh },
  ]
}

const dataDirError = (dir: string): string | undefined => {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return undefined
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EACCES' ? '没有写权限' : (e as Error).message
  }
}

const gitVersion = (): string | undefined => {
  try {
    return /\d+\.\d+(\.\d+)?/.exec(execFileSync('git', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))?.[0]
  } catch {
    return undefined
  }
}

/** 收集事实。root 是仓库目录（package.json 和 node_modules 所在）。会建出数据目录（和别的命令一样）。 */
export const gather = (o: { root: string; dataDir: string; env: NodeJS.ProcessEnv }): Facts => {
  const pkg = JSON.parse(readFileSync(join(o.root, 'package.json'), 'utf8')) as { engines?: { node?: string } }
  const dshPkg = join(o.root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const dsh = existsSync(join(o.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) && existsSync(dshPkg)
    ? (JSON.parse(readFileSync(dshPkg, 'utf8')) as { version: string }).version : undefined
  const git = gitVersion()
  const error = dataDirError(o.dataDir)
  return {
    node: process.versions.node, nodeRequired: pkg.engines?.node ?? '>=0', apiKey: (o.env.DEEPSEEK_API_KEY ?? '').trim() !== '',
    ...(git === undefined ? {} : { git }), dataDir: o.dataDir, ...(error === undefined ? {} : { dataDirError: error }), ...(dsh === undefined ? {} : { dsh }),
  }
}

export const formatItems = (items: Item[]): string =>
  items.map(i => `${i.ok ? '✓' : '✗'} ${i.name}：${i.detail}${i.ok || i.fix === undefined ? '' : `\n  怎么修：${i.fix}`}`).join('\n')
