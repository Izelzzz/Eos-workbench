// 远程仓库在平台数据目录里的镜像：repos/<主机>/<owner>/<仓库>.git（owner 和仓库名用小写），一个 bare 仓库。任务的 worktree 从它建。
// - 镜像的配置里不存远程地址和任何凭据：每次 fetch 都在命令行上给出不带凭据的地址。
// - 令牌只放进这一次 git 子进程的环境变量（GIT_CONFIG_* 里的一行 HTTP 认证头），不上命令行（ps 能看到），不写进任何文件。
// - git 子进程不读宿主机的全局、系统配置和 ~/.netrc（HOME 换成平台的空目录），也不继承 GIT_CONFIG_PARAMETERS、GIT_SSL_NO_VERIFY：
//   url.*.insteadOf 之类的配置能把地址改走，绕开平台的令牌。宿主机用 GIT_CONFIG_COUNT 注入的配置照样生效（部署方的代理等设置靠它）。
// - 每次访问远程前核对镜像自己的配置只有平台写过的项：没有 bwrap 时 agent 能读写整个文件系统，可能往镜像的配置里加代理。
// - 异步执行，有超时：克隆大仓库时 Web 服务照常响应。
// - 同一个镜像：本进程内排队依次更新；跨进程用锁文件，别的进程正在更新时报"稍后再试"。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RemoteRepo } from '../forge/types.ts'
import { SAFE } from './git.ts'
import { acquire } from './lock.ts'

const run = promisify(execFile)

export type Mirror = { gitDir: string; branch: string; baseSha: string }

/** 一次 git 访问远程最多这么久；另外传输速度连续 60 秒低于 1KB/s 也算失败（连接卡住时不会一直挂着）。 */
export const REMOTE_TIMEOUT_MS = 30 * 60 * 1000

/** GitHub 的 owner 和仓库名不分大小写：镜像路径用小写，同一个仓库不会因为写法不同克隆两份。 */
export const mirrorDir = (dataDir: string, r: RemoteRepo): string =>
  join(resolve(dataDir), 'repos', r.host, r.owner.toLowerCase(), `${r.name.toLowerCase()}.git`)

/** 给 git 子进程加配置：接在环境里已有的 GIT_CONFIG_COUNT 项后面。 */
export const withGitConfig = (env: NodeJS.ProcessEnv, pairs: [string, string][]): NodeJS.ProcessEnv => {
  const n = /^\d+$/.test(env.GIT_CONFIG_COUNT ?? '') ? Number(env.GIT_CONFIG_COUNT) : 0
  const out: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(n + pairs.length) }
  pairs.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = k
    out[`GIT_CONFIG_VALUE_${n + i}`] = v
  })
  return out
}

/**
 * 访问远程仓库时 git 的环境：不读宿主机的全局、系统配置和凭据助手，不弹出输入用户名密码的提示，传输卡住时失败；
 * 有令牌时只对这个托管平台的地址带认证头。
 */
export const remoteEnv = (repo: RemoteRepo, authHeader: string | undefined, home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const { GIT_CONFIG_PARAMETERS: _p, GIT_SSL_NO_VERIFY: _v, ...rest } = env
  return withGitConfig({ ...rest, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }, [
    ['credential.helper', ''],
    ['http.sslVerify', 'true'],
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '60'],
    ...(authHeader === undefined ? [] : [[`http.${new URL(repo.cloneUrl).origin}/.extraheader`, authHeader] as [string, string]]),
  ])
}

/** git init --bare 写进镜像配置的项。别的项（代理、include、url 改写……）都不是平台写的。 */
const MIRROR_CONFIG = /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/

/** 镜像配置里不是平台写的项；读不出时当作被改过。 */
export const foreignConfig = (gitDir: string): string[] => {
  try {
    const keys = readFileSync(join(gitDir, 'config'), 'utf8').split('\n')
    let section = ''
    const out: string[] = []
    for (const raw of keys) {
      const line = raw.replace(/[#;].*$/, '').trim()
      if (line === '') continue
      const sec = /^\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]$/.exec(line)
      if (sec !== null) {
        section = sec[2] === undefined ? sec[1]!.toLowerCase() : `${sec[1]!.toLowerCase()}.${sec[2]}`
        continue
      }
      const key = `${section}.${line.split('=')[0]!.trim().toLowerCase()}`
      if (!MIRROR_CONFIG.test(key)) out.push(key)
    }
    return out
  } catch {
    return ['(读不出配置文件)']
  }
}

/** raw：git 的原始报错（已抹掉令牌和认证头），给调用方按具体情况再判断。 */
export class MirrorError extends Error {
  constructor(message: string, readonly raw = '') {
    super(message)
  }
}

/** 把 secrets 换成 ***。 */
export const scrub = (text: string, secrets: string[]): string => secrets.filter(x => x !== '').reduce((t, x) => t.split(x).join('***'), text)

/** git 的报错换成给用户看的中文原因。secrets 出现在报错里时抹掉（git 不会打印请求头，这里是兜底）。 */
export const explain = (repo: RemoteRepo, stderr: string, o: { credential: string; hasToken: boolean; secrets?: string[] }): string => {
  const raw = scrub(stderr, o.secrets ?? [])
  const where = `${repo.host} 上的 ${repo.owner}/${repo.name}`
  if (/Authentication failed|could not read Username|terminal prompts disabled|returned error: 40[13]|HTTP 40[13]|403 Forbidden|401 Unauthorized/i.test(raw)) {
    if (o.hasToken && o.credential.startsWith('github-app.')) return `${repo.host} 拒绝了访问 ${where}：凭据「${o.credential}」的 GitHub App 换来的令牌没有权限，检查 App 在这个仓库的安装和 Contents 权限`
    return o.hasToken
      ? `${repo.host} 拒绝了访问 ${where}：凭据「${o.credential}」里的令牌无效、已过期，或者没有授权这个仓库。在凭据页替换这条凭据`
      : `${repo.host} 拒绝了访问 ${where}：这是私有仓库或需要登录。在凭据页添加名字为「${o.credential}」、类型为 Git 令牌的凭据`
  }
  if (/Repository not found|repository '[^']*' not found|returned error: 404/i.test(raw)) {
    return `找不到仓库 ${where}：地址写错了，或者${o.hasToken ? `凭据「${o.credential}」里的令牌` : '没有令牌时'}看不到这个仓库`
  }
  if (/Could not resolve host|Failed to connect|Connection refused|timed out|Connection reset|too slow/i.test(raw)) return `连不上 ${repo.host}：${raw.trim().split('\n').at(-1)}`
  return `访问 ${where} 失败：${raw.trim().split('\n').at(-1) ?? ''}`
}

export type RemoteAuth = { header?: string; credential: string; secret?: string }

/** 报错里要抹掉的内容：令牌本身，和认证头里的凭据部分（例如 Basic 后面的 base64）。 */
export const secretsOf = (auth: { header?: string; secret?: string }): string[] =>
  [auth.secret ?? '', auth.header?.replace(/^Authorization:\s*\w+\s+/i, '') ?? ''].filter(x => x !== '')

/** 本进程里每个镜像正在进行的操作：同一个镜像的操作排队，依次进行。 */
const queues = new Map<string, Promise<unknown>>()

type Git = (args: string[]) => Promise<string>

/**
 * 对一个镜像做一次访问远程的操作：本进程内排队、跨进程加锁，准备好 git 的环境，核对镜像的配置，再执行 fn。
 * create：镜像不存在时新建（失败时删掉这次新建的）；不 create 时镜像必须已经存在。
 */
const withMirror = <T,>(dataDir: string, repo: RemoteRepo, auth: RemoteAuth, create: boolean, fn: (git: Git, gitDir: string) => Promise<T>): Promise<T> => {
  const gitDir = mirrorDir(dataDir, repo)
  const prev = queues.get(gitDir) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(() => once(dataDir, gitDir, repo, auth, create, fn))
  queues.set(gitDir, next)
  void next.catch(() => {}).finally(() => {
    if (queues.get(gitDir) === next) queues.delete(gitDir)
  })
  return next
}

const once = async <T,>(dataDir: string, gitDir: string, repo: RemoteRepo, auth: RemoteAuth, create: boolean, fn: (git: Git, gitDir: string) => Promise<T>): Promise<T> => {
  const lockId = `mirror-${createHash('sha256').update(gitDir).digest('hex').slice(0, 16)}`
  const lock = acquire(join(resolve(dataDir), 'locks'), lockId)
  if ('heldBy' in lock) throw new MirrorError(`另一个进程（${lock.heldBy}）正在使用 ${repo.owner}/${repo.name} 的镜像，稍后再试`)
  // 拿到锁之后再看镜像在不在：失败时只删自己这次新建的，不会删掉别的进程刚建好的。
  const fresh = !existsSync(join(gitDir, 'HEAD'))
  if (fresh && !create) {
    lock.release()
    throw new MirrorError(`平台数据目录里没有 ${repo.owner}/${repo.name} 的镜像：${gitDir}`)
  }
  const home = join(resolve(dataDir), 'git-home')
  mkdirSync(home, { recursive: true })
  const env = remoteEnv(repo, auth.header, home)
  const secrets = secretsOf(auth)
  const git: Git = async args => {
    try {
      const { stdout } = await run('git', [...SAFE, '--git-dir', gitDir, ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: REMOTE_TIMEOUT_MS })
      return stdout.trim()
    } catch (e) {
      const err = e as { stderr?: unknown; killed?: boolean; message: string }
      const stderr = err.killed === true ? `timed out after ${REMOTE_TIMEOUT_MS / 60000} minutes` : String(err.stderr ?? err.message)
      throw new MirrorError(explain(repo, stderr, { credential: auth.credential, hasToken: auth.header !== undefined, secrets }), scrub(stderr, secrets))
    }
  }
  try {
    if (fresh) {
      mkdirSync(gitDir, { recursive: true })
      await run('git', ['init', '--bare', '-q', gitDir], { env })
    }
    const foreign = foreignConfig(gitDir)
    if (foreign.length > 0) throw new MirrorError(`镜像 ${gitDir} 的配置里有不是平台写的项（${foreign.join('、')}），为了不把令牌发到别处，没有访问远程。请人工检查这个镜像，确认后删掉这些项或删掉整个镜像`)
    return await fn(git, gitDir)
  } catch (e) {
    if (fresh) rmSync(gitDir, { recursive: true, force: true })
    throw e
  } finally {
    lock.release()
  }
}

/**
 * 更新镜像：没有就建一个空的 bare 仓库，问远程的默认分支，把它 fetch 到 refs/remotes/origin/<分支>，返回它最新的提交。
 * 远程是空仓库（还没有提交）时报错。所有错误都是 MirrorError，消息是给用户看的中文。
 */
export const syncMirror = (dataDir: string, repo: RemoteRepo, auth: RemoteAuth): Promise<Mirror> =>
  withMirror(dataDir, repo, auth, true, async (git, gitDir) => {
    // 输出形如 "ref: refs/heads/main\tHEAD\n<sha>\tHEAD"；空仓库什么都不输出。
    const head = await git(['ls-remote', '--symref', repo.cloneUrl, 'HEAD'])
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1]
    if (branch === undefined) throw new MirrorError(`${repo.owner}/${repo.name} 还没有任何提交（空仓库），先推一个提交上去`)
    await git(['fetch', '-q', '--no-tags', repo.cloneUrl, `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    return { gitDir, branch, baseSha: await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]) }
  })

/** 远程现在的默认分支（ls-remote 的 HEAD）。镜像必须已经存在。 */
export const remoteDefaultBranch = (dataDir: string, repo: RemoteRepo, auth: RemoteAuth): Promise<string> =>
  withMirror(dataDir, repo, auth, false, async git => {
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(await git(['ls-remote', '--symref', repo.cloneUrl, 'HEAD']))?.[1]
    if (branch === undefined) throw new MirrorError(`问不出 ${repo.owner}/${repo.name} 的默认分支`)
    return branch
  })

/**
 * 把核对过的提交 sha 推到远程的 branch 分支，不强推。推的是这个提交，不是推送时分支指向的提交：核对和推送之间分支被移动也不影响。
 * 远程的这个分支有平台没有的提交（被别人改过）时失败：平台不覆盖别人的提交。
 */
export const pushBranch = (dataDir: string, repo: RemoteRepo, auth: RemoteAuth, branch: string, sha: string): Promise<{ sha: string }> =>
  withMirror(dataDir, repo, auth, false, async git => {
    if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new MirrorError(`不是提交号：${sha}`)
    try {
      await git(['push', '-q', '--no-verify', repo.cloneUrl, `${sha}:refs/heads/${branch}`])
    } catch (e) {
      if (e instanceof MirrorError && /\[rejected\]|non-fast-forward|fetch first/.test(e.raw)) {
        throw new MirrorError(`${repo.host} 上的分支 ${branch} 已经有平台没有的提交（被别人推过或改过），平台不强推，没有覆盖它。请人工处理这个分支（例如合并后再推，或删掉远程分支），然后重试`)
      }
      throw e
    }
    return { sha }
  })
