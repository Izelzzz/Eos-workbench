// 启动检查：平台进程所在的机器能不能跑任务。eos doctor 列出全部检查；会调用模型的命令启动前跑同样的检查：
// 有 ✗（缺了就一定跑不起来：API key、git、数据目录、dsh）就不启动；只有 ⚠（Node 版本低于声明的要求，实际可能能跑）时提示后照常启动。
// 检查的是平台进程自己（Node、环境变量、git、数据目录、dsh），部署到服务器上时检查的就是服务器。
import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { GENERATE_HINT, MASTER_KEY_ENV, type MasterKeyState } from '../credentials/key.ts'
import { MODEL_KEY_CREDENTIAL, MODEL_KEY_ENV, type ModelKey } from '../credentials/model-key.ts'
import { dshInstall, dshSandbox, type DshSandbox } from '../executor/dsh.ts'

/** ok：满足；warn：不满足但可能还能跑，只提示；fail：缺了一定跑不起来，启动前拦下。 */
export type Status = 'ok' | 'warn' | 'fail'
/** doctorOnly：只在 eos doctor 里列出，启动前检查不提示（总会出现的 ⚠ 会让人习惯性忽略真正的提示）。 */
export type Item = { name: string; status: Status; detail: string; fix?: string; doctorOnly?: true }

/** 收集到的事实。evaluate 只看它，不做 IO，可单测。 */
export type Facts = {
  node: string
  /** Eos 的 package.json 里 engines.node，例如 ">=24.9.0"；读不出来时是 undefined。 */
  nodeRequired?: string
  /** 模型 API key 的来源：只有来源，没有 key 本身。 */
  modelKey: { source: 'credentials' | 'env' | 'missing' } | { source: 'error'; error: string }
  /** 凭据主密钥：只有状态和指纹，没有密钥本身。 */
  masterKey: { kind: 'ok'; id: string } | { kind: 'missing' } | { kind: 'invalid'; error: string }
  /** git 的版本号，或者 git 找不到、运行失败的原因。 */
  git: { version: string } | { missing: true } | { error: string }
  dataDir: string
  /** 数据目录建不出来或不可写时的错误。 */
  dataDirError?: string
  /** dsh 实际会用的沙箱（探测得出，不是只看装没装）。 */
  sandbox: DshSandbox
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

/** 没设置只提示：现在还没有功能离不开凭据。设置了但格式不对一定是配错了，拦下。 */
const masterKeyItem = (f: Facts): Item =>
  f.masterKey.kind === 'ok'
    ? { name: '凭据主密钥', status: 'ok', detail: `已设置 ${MASTER_KEY_ENV}（指纹 ${f.masterKey.id}）` }
    : f.masterKey.kind === 'missing'
      ? { name: '凭据主密钥', status: 'warn', detail: `没有设置 ${MASTER_KEY_ENV}，不能保存或读取凭据`, fix: GENERATE_HINT, doctorOnly: true }
      : { name: '凭据主密钥', status: 'fail', detail: f.masterKey.error, fix: GENERATE_HINT }

/**
 * dsh 会用哪个沙箱。都不能用时 dsh 拒绝执行命令，任务一定失败，所以是 ✗。
 * Landlock 和 bwrap 都限制 agent 只能写自己的 worktree，也都挡住 agent 读别的进程的环境（/proc/<pid>/environ）；
 * Landlock 不隔离进程号空间和 /tmp（agent 看得到进程列表，各任务共用 /tmp）。
 */
const sandboxItem = (f: Facts): Item => {
  const name = '沙箱'
  switch (f.sandbox.backend) {
    case 'bwrap': return { name, status: 'ok', detail: 'bwrap：agent 只能写自己的 worktree，在单独的进程号空间里；能写的 agent 有私有的 /tmp，只读的 agent 看到的是共用的 /tmp' }
    case 'landlock': return f.sandbox.enforcement === 'full'
      ? { name, status: 'ok', detail: 'Landlock（bwrap 用不了）：能写的 agent 只能写自己的 worktree 和 /tmp，只读的 agent 什么都写不了；agent 读不到别的进程的环境，但看得到进程列表，各任务共用 /tmp' }
      : { name, status: 'warn', detail: 'Landlock，但内核的 Landlock 版本较旧，只能限制一部分写操作（bwrap 用不了）', fix: '换用较新的内核，或让 bwrap 可用（在容器里需要放开 user namespace，见 docs/adr/006-docker-deployment.md）' }
    case 'none': return { name, status: 'fail', detail: 'bwrap 和 Landlock 都用不了：dsh 会拒绝执行命令，任务跑不起来', fix: '安装 bubblewrap 并允许非特权 user namespace，或使用启用了 Landlock 的内核（Linux 5.13 以上，LSM 列表里有 landlock）' }
    case 'platform': return { name, status: 'ok', detail: `${f.sandbox.platform}：由 dsh 选用系统自带的沙箱（macOS Seatbelt；Windows 受限令牌，只能部分限制），这里没有探测` }
  }
}

/**
 * 设置了主密钥时提示还没隔离的地方：平台进程启动时的环境（/proc/<pid>/environ）里一直有主密钥，读出后删不掉；dsh 进程的环境里有模型 key。
 * 沙箱挡住了 agent；检查命令（npm test 等）不在沙箱里、和平台是同一个用户，总能读到。
 * 要用独立的用户运行检查命令和 agent 才能隔离（路线图第 3 项，还没有做完）。
 */
const isolationItem = (f: Facts): Item[] => {
  if (f.masterKey.kind !== 'ok') return []
  const checks = '检查命令（npm test 等）和平台是同一个用户、不在沙箱里，能读到平台进程环境里的主密钥，以及 dsh 进程环境里的模型 key'
  const detail = f.sandbox.backend === 'none'
    ? `没有可用的沙箱：agent 和检查命令都能读到平台进程环境里的主密钥，以及 dsh 进程环境里的模型 key`
    : f.sandbox.backend === 'platform' ? checks : `agent 在沙箱里读不到它们；${checks}`
  return [{ name: '凭据隔离', status: 'warn', doctorOnly: true, detail, fix: '用独立的用户运行检查命令和 agent（路线图第 3 项，还没有做完）；在那之前只在可信的仓库和需求上使用' }]
}

const MODEL_KEY_FIX = `在 Web 的「凭据」页添加名为 ${MODEL_KEY_CREDENTIAL}、类型为「模型 API key」的凭据（需要先设置主密钥 ${MASTER_KEY_ENV}）；或在启动平台的环境里设置 ${MODEL_KEY_ENV}=<你的 key>`

/** 凭据存储优先；里面没有才用环境变量。只检查有没有，不检查是否有效。 */
const modelKeyItem = (f: Facts): Item => {
  const name = 'DeepSeek API key'
  switch (f.modelKey.source) {
    case 'credentials': return { name, status: 'ok', detail: `来自凭据存储（凭据 ${MODEL_KEY_CREDENTIAL}）` }
    case 'env': return { name, status: 'ok', detail: `来自环境变量 ${MODEL_KEY_ENV}（凭据存储里没有 ${MODEL_KEY_CREDENTIAL}）` }
    case 'missing': return { name, status: 'fail', detail: `凭据存储里没有 ${MODEL_KEY_CREDENTIAL}，也没有设置环境变量 ${MODEL_KEY_ENV}`, fix: MODEL_KEY_FIX }
    case 'error': return { name, status: 'fail', detail: `凭据存储里的 ${MODEL_KEY_CREDENTIAL} 读不出来：${f.modelKey.error}`, fix: `修好或删掉这条凭据后重新录入；删掉后会改用环境变量 ${MODEL_KEY_ENV}` }
  }
}

export const evaluate = (f: Facts): Item[] => [
  nodeItem(f),
  modelKeyItem(f),
  masterKeyItem(f),
  sandboxItem(f),
  ...isolationItem(f),
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
export const gather = (o: { root: string; dataDir: string; modelKey: ModelKey; masterKey: MasterKeyState }): Facts => {
  const required = nodeRequired(o.root)
  const dsh = dshInstall(o.root)?.version
  const error = dataDirError(o.dataDir)
  return {
    node: process.versions.node, ...(required === undefined ? {} : { nodeRequired: required }), modelKey: o.modelKey.source === 'credentials' || o.modelKey.source === 'env' ? { source: o.modelKey.source } : o.modelKey,
    masterKey: o.masterKey.kind === 'ok' ? { kind: 'ok', id: o.masterKey.key.id } : o.masterKey,
    git: gitState(), sandbox: dshSandbox(), dataDir: o.dataDir, ...(error === undefined ? {} : { dataDirError: error }), ...(dsh === undefined ? {} : { dsh }),
  }
}

const MARK: Record<Status, string> = { ok: '✓', warn: '⚠', fail: '✗' }

export const formatItems = (items: Item[]): string =>
  items.map(i => `${MARK[i.status]} ${i.name}：${i.detail}${i.status === 'ok' || i.fix === undefined ? '' : `\n  怎么修：${i.fix}`}`).join('\n')
