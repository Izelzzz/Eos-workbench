// 启动检查：平台进程所在的机器能不能跑任务。eos doctor 列出全部检查；会调用模型的命令启动前跑同样的检查：
// 有 ✗（缺了就一定跑不起来：git、数据目录、执行器报告的问题）就不启动；只有 ⚠（Node 版本低于声明的要求，实际可能能跑）时提示后照常启动。
// 检查的是平台进程自己（Node、环境变量、git、数据目录）和每个执行器的自检（装没装、沙箱、凭据，见 Executor 的 health），
// 部署到服务器上时检查的就是服务器。
import { execFileSync } from 'node:child_process'
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { GENERATE_HINT, MASTER_KEY_ENV, type MasterKeyState } from '../credentials/key.ts'
import type { Health, HealthItem, HealthStatus } from '../executor/types.ts'
import { AGENT_USER_ENV, CHECK_USER_ENV, probeSwitch, type CheckUserState } from './check-user.ts'
import { droppedProxies } from './checks.ts'

export type Status = HealthStatus
export type Item = HealthItem

/** 一个独立用户：没有设置、能切换过去、设置错了或切换不过去（原因）。 */
export type UserFact = { kind: 'none' } | { kind: 'ok'; name: string } | { kind: 'fail'; error: string }

/** 收集到的事实。evaluate 只看它，不做 IO，可单测。 */
export type Facts = {
  node: string
  /** Eos 的 package.json 里 engines.node，例如 ">=24.9.0"；读不出来时是 undefined。 */
  nodeRequired?: string
  /** 凭据主密钥：只有状态和指纹，没有密钥本身。 */
  masterKey: { kind: 'ok'; id: string } | { kind: 'missing' } | { kind: 'invalid'; error: string }
  /** git 的版本号，或者 git 找不到、运行失败的原因。 */
  git: { version: string } | { missing: true } | { error: string }
  dataDir: string
  /** 数据目录建不出来或不可写时的错误。 */
  dataDirError?: string
  /** 每个执行器的自检，按注册表登记的顺序。 */
  executors: { name: string; health: Health }[]
  /** 检查命令用的系统用户：没有设置、能切换过去、设置错了或切换不过去（原因）。 */
  checkUser: UserFact
  /** dsh 和 agent 用的系统用户，同上。 */
  agentUser: UserFact
  /** 带账号密码、所以没有传给检查命令的代理变量。 */
  droppedProxies: string[]
}

const parts = (v: string): number[] =>
  v
    .replace(/^v/, '')
    .split('.')
    .map(x => Number.parseInt(x, 10) || 0)

/** a ≥ b（按主、次、修订号比较）。 */
export const atLeast = (a: string, b: string): boolean => {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return true
}

const nodeItem = (f: Facts): Item => {
  if (f.nodeRequired === undefined) return { name: 'Node', status: 'warn', detail: `${f.node}；读不出 Eos 的 package.json 里的 engines.node`, fix: '在仓库目录重新拉取代码，确认 package.json 完整' }
  const min = /^>=\s*(\d+(\.\d+){0,2})$/.exec(f.nodeRequired.trim())?.[1]
  if (min === undefined)
    return { name: 'Node', status: 'warn', detail: `${f.node}；认不出 engines.node 的写法「${f.nodeRequired}」，没法判断版本够不够`, fix: '把 package.json 的 engines.node 写成 ">=主.次.修订" 的形式' }
  return atLeast(f.node, min)
    ? { name: 'Node', status: 'ok', detail: `${f.node}（要求 ${f.nodeRequired}）` }
    : {
        name: 'Node',
        status: 'warn',
        detail: `${f.node}，低于 Eos 要求的 ${f.nodeRequired}（package.json 的 engines，和 dsh 声明的要求一致）；照常启动，但可能遇到兼容问题`,
        fix: `安装 Node ${min} 或更新的版本，再用它启动平台`,
      }
}

/** 没设置只提示：现在还没有功能离不开凭据。设置了但格式不对一定是配错了，拦下。 */
const masterKeyItem = (f: Facts): Item =>
  f.masterKey.kind === 'ok'
    ? { name: '凭据主密钥', status: 'ok', detail: `已设置 ${MASTER_KEY_ENV}（指纹 ${f.masterKey.id}）` }
    : f.masterKey.kind === 'missing'
      ? { name: '凭据主密钥', status: 'warn', detail: `没有设置 ${MASTER_KEY_ENV}，不能保存或读取凭据`, fix: GENERATE_HINT, doctorOnly: true }
      : { name: '凭据主密钥', status: 'fail', detail: f.masterKey.error, fix: GENERATE_HINT }

/** 执行器进程的说法：带上登记的执行器名字，例如「执行器进程（dsh）」。 */
const executorProcess = (f: Facts): string => (f.executors.length === 0 ? '执行器进程' : `执行器进程（${f.executors.map(e => e.name).join('、')}）`)

/**
 * 检查命令用哪个用户运行。设置了却切换不过去时 ✗：检查命令一定跑不起来，也不能退回到用平台的用户运行。
 * 没有设置时不列出，由「凭据隔离」说明检查命令和平台是同一个用户。
 */

const checkUserItem = (f: Facts): Item[] => {
  const name = '检查命令的用户'
  switch (f.checkUser.kind) {
    case 'none':
      return []
    case 'ok':
      return [{ name, status: 'ok', detail: `检查命令以 ${f.checkUser.name} 运行，没有任何特权，读不到平台和${executorProcess(f)}的环境` }]
    case 'fail':
      return [
        {
          name,
          status: 'fail',
          detail: f.checkUser.error,
          fix: `${CHECK_USER_ENV} 要是系统里已有的用户，平台进程要有 SETUID、SETGID 能力（容器里用镜像带的 eos 命令启动，compose 里 cap_add 这两项，见 docs/deploy.md）；不在容器里时去掉 ${CHECK_USER_ENV}`,
        },
      ]
  }
}

/** 代理地址带账号密码时不传给检查命令：联网的检查（npm install 等）在必须走代理的服务器上会失败。 */
const proxyItem = (f: Facts): Item[] =>
  f.droppedProxies.length === 0
    ? []
    : [
        {
          name: '检查命令的代理',
          status: 'warn',
          detail: `${f.droppedProxies.join('、')} 带账号密码，没有传给检查命令：检查命令跑的是 agent 改过的代码`,
          fix: '换成不需要账号密码的代理（例如按来源地址放行），或让检查命令不需要联网（依赖由 agent 装好）',
        },
      ]

/**
 * 执行器进程和 agent 用哪个用户运行（切换由执行器做，例如 dsh 的入口 deploy/dsh-launch.mjs；这里真的切换一次确认平台有这个能力，
 * 每个执行器也报告自己能不能切换过去）。设置了却切换不过去时 ✗：执行器起不来，任务一定失败。没有设置时不列出，由「凭据隔离」说明。
 */
const agentUserItem = (f: Facts): Item[] => {
  const name = 'agent 的用户'
  switch (f.agentUser.kind) {
    case 'none':
      return []
    case 'ok':
      return [{ name, status: 'ok', detail: `${executorProcess(f)}和 agent 以 ${f.agentUser.name} 运行，没有任何特权，读不到平台进程的环境` }]
    case 'fail':
      return [
        {
          name,
          status: 'fail',
          detail: f.agentUser.error,
          fix: `${AGENT_USER_ENV} 要是系统里已有的用户，平台进程要有 SETUID、SETGID、KILL 能力（容器里用镜像带的 eos 命令启动，compose 里 cap_add 这三项，见 docs/deploy.md）；不在容器里时去掉 ${AGENT_USER_ENV}`,
        },
      ]
  }
}

/**
 * 设置了主密钥时说明谁能读到两样凭据：平台进程启动时的环境（/proc/<pid>/environ）里一直有主密钥，读出后删不掉；执行器进程的环境里有模型 key。
 * 别的用户的进程读不到；同一个用户的进程只靠沙箱挡住。agent 是执行器启动的，和执行器进程总是同一个用户，所以模型 key 对 agent 总是只靠沙箱。
 * 检查命令和 agent 都换成独立的用户、沙箱也在时是 ✓。
 */
const isolationItem = (f: Facts): Item[] => {
  if (f.masterKey.kind !== 'ok') return []
  // 没有任何执行器报告时不能说有沙箱
  const sandboxed = f.executors.length > 0 && f.executors.every(e => e.health.sandboxed)
  const checks = f.checkUser.kind === 'ok' ? `检查命令以 ${f.checkUser.name} 运行，主密钥和模型 key 都读不到` : '检查命令（npm test 等）和平台是同一个用户、不在沙箱里，主密钥和模型 key 都能读到'
  const agentMaster =
    f.agentUser.kind === 'ok'
      ? `agent 以 ${f.agentUser.name} 运行，读不到平台进程环境里的主密钥`
      : sandboxed
        ? 'agent 和平台是同一个用户，读不到主密钥只靠沙箱挡住'
        : '没有可用的沙箱，agent 和平台是同一个用户，能读到主密钥'
  const agentModel = sandboxed ? `agent 和${executorProcess(f)}是同一个用户，读不到执行器进程环境里的模型 key 靠沙箱挡住` : `没有可用的沙箱，agent 能读到${executorProcess(f)}环境里的模型 key`
  const detail = `${agentMaster}；${agentModel}；${checks}`
  const ok = f.checkUser.kind === 'ok' && f.agentUser.kind === 'ok' && sandboxed
  if (ok) return [{ name: '凭据隔离', status: 'ok', detail }]
  return [
    {
      name: '凭据隔离',
      status: 'warn',
      doctorOnly: true,
      detail,
      fix: '用独立的用户运行检查命令和 agent（Docker 部署就是这样，见 docs/deploy.md「用户和权限」），并让沙箱可用；在那之前只在可信的仓库和需求上使用',
    },
  ]
}

export const evaluate = (f: Facts): Item[] => [
  nodeItem(f),
  ...f.executors.flatMap(e => e.health.items),
  masterKeyItem(f),
  ...checkUserItem(f),
  ...agentUserItem(f),
  ...proxyItem(f),
  ...isolationItem(f),
  'version' in f.git
    ? { name: 'git', status: 'ok', detail: f.git.version }
    : 'missing' in f.git
      ? { name: 'git', status: 'fail', detail: '找不到 git 命令', fix: '安装 git，并确认它在平台进程的 PATH 里' }
      : { name: 'git', status: 'fail', detail: `git 运行失败：${f.git.error}`, fix: '在平台所在的机器上运行 git --version，按报错修好 git' },
  f.dataDirError === undefined
    ? { name: '数据目录', status: 'ok', detail: `${f.dataDir} 可写` }
    : { name: '数据目录', status: 'fail', detail: `${f.dataDir}：${f.dataDirError}`, fix: '用 --data <目录> 或环境变量 EOS_HOME 换一个平台进程能写的目录，或修改这个目录的权限' },
]

/** 数据目录建不出来、不可写时，常见的错误码给中文说明，原始错误码放在括号里。 */
const DIR_ERRORS: Record<string, string> = {
  EACCES: '没有写权限',
  EPERM: '没有权限',
  EROFS: '所在的文件系统是只读的',
  ENOTDIR: '路径里有一段不是目录（是普通文件）',
  EEXIST: '已经有同名的文件',
  ENOSPC: '磁盘空间不足',
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
    return {
      error: String((e as { stderr?: unknown }).stderr ?? (e as Error).message)
        .trim()
        .split('\n')[0]!,
    }
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

/** 本进程的有效能力里有 CAP_KILL（第 5 位）。读不出来时当作没有。 */
const hasCapKill = (): boolean => {
  try {
    const hex = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
    return hex !== undefined && (BigInt(`0x${hex}`) & 0x20n) !== 0n
  } catch {
    return false
  }
}

/** 收集事实。root 是仓库目录（package.json 和 node_modules 所在）。会建出数据目录（和别的命令一样）。 */
export const gather = (
  o: { root: string; dataDir: string; executors: Facts['executors']; masterKey: MasterKeyState; checkUser: CheckUserState; agentUser: CheckUserState },
  env: NodeJS.ProcessEnv = process.env,
): Facts => {
  const required = nodeRequired(o.root)
  const error = dataDirError(o.dataDir)
  const userFact = (u: CheckUserState): UserFact => {
    if (u.kind !== 'ok') return u.kind === 'none' ? u : { kind: 'fail', error: u.error }
    const e = probeSwitch(u.user)
    return e === undefined ? { kind: 'ok', name: u.user.name } : { kind: 'fail', error: `切换不到 ${u.user.name}：${e}` }
  }
  // agent 的用户还要两样：每个执行器都能切换过去（各自报告，例如 dsh 要设置它的入口）；执行器进程属于别的用户，平台要有 KILL 才能关掉它。
  const agentFact = (u: CheckUserState): UserFact => {
    const f = userFact(u)
    if (f.kind !== 'ok') return f
    const cannot = o.executors.flatMap(e => (e.health.agentUser === undefined ? [] : [e.health.agentUser]))
    if (cannot.length > 0) return { kind: 'fail', error: cannot.join('；') }
    if (!hasCapKill()) return { kind: 'fail', error: `平台进程没有 KILL 能力：执行器进程以 ${f.name} 运行，平台关不掉它（换 key、释放进程时）` }
    return f
  }
  return {
    node: process.versions.node,
    ...(required === undefined ? {} : { nodeRequired: required }),
    masterKey: o.masterKey.kind === 'ok' ? { kind: 'ok', id: o.masterKey.key.id } : o.masterKey,
    git: gitState(),
    executors: o.executors,
    dataDir: o.dataDir,
    ...(error === undefined ? {} : { dataDirError: error }),
    checkUser: userFact(o.checkUser),
    agentUser: agentFact(o.agentUser),
    droppedProxies: droppedProxies(env),
  }
}

const MARK: Record<Status, string> = { ok: '✓', warn: '⚠', fail: '✗' }

export const formatItems = (items: Item[]): string => items.map(i => `${MARK[i.status]} ${i.name}：${i.detail}${i.status === 'ok' || i.fix === undefined ? '' : `\n  怎么修：${i.fix}`}`).join('\n')
