// 远程仓库在平台数据目录里的镜像：repos/<主机>/<owner>/<仓库>.git（owner 和仓库名用小写），一个 bare 仓库。任务的 worktree 从它建。
// - 镜像的配置里不存远程地址和任何凭据：每次 fetch 都在命令行上给出不带凭据的地址。
// - 令牌只放进这一次 git 子进程的环境变量（GIT_CONFIG_* 里的一行 HTTP 认证头），不上命令行（ps 能看到），不写进任何文件。
// - git 子进程不读宿主机的全局和系统配置：url.*.insteadOf 之类的配置能把地址改走，绕开平台的令牌。
// - 异步执行，有超时：克隆大仓库时 Web 服务照常响应。
// - 同一个镜像同一时间只让一个进程更新（锁文件），别的进程直接报"稍后再试"。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
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
export const remoteEnv = (repo: RemoteRepo, authHeader: string | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  withGitConfig({ ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }, [
    ['credential.helper', ''],
    ['http.lowSpeedLimit', '1000'],
    ['http.lowSpeedTime', '60'],
    ...(authHeader === undefined ? [] : [[`http.${new URL(repo.cloneUrl).origin}/.extraheader`, authHeader] as [string, string]]),
  ])

export class MirrorError extends Error {}

/** git 的报错换成给用户看的中文原因。secrets 出现在报错里时抹掉（git 不会打印请求头，这里是兜底）。 */
export const explain = (repo: RemoteRepo, stderr: string, o: { credential: string; hasToken: boolean; secrets?: string[] }): string => {
  const raw = (o.secrets ?? []).filter(x => x !== '').reduce((text, x) => text.split(x).join('***'), stderr)
  const where = `${repo.host} 上的 ${repo.owner}/${repo.name}`
  if (/Authentication failed|could not read Username|terminal prompts disabled|returned error: 40[13]|HTTP 40[13]|403 Forbidden|401 Unauthorized/i.test(raw)) {
    return o.hasToken
      ? `${repo.host} 拒绝了访问 ${where}：凭据「${o.credential}」里的令牌无效、已过期，或者没有授权这个仓库。在凭据页替换这条凭据`
      : `${repo.host} 拒绝了访问 ${where}：这是私有仓库或需要登录。在凭据页添加名字为「${o.credential}」、类型为 Git 令牌的凭据`
  }
  if (/Repository not found|not found|returned error: 404/i.test(raw)) {
    return `找不到仓库 ${where}：地址写错了，或者${o.hasToken ? `凭据「${o.credential}」里的令牌` : '没有令牌时'}看不到这个仓库`
  }
  if (/Could not resolve host|Failed to connect|Connection refused|timed out|Connection reset|too slow/i.test(raw)) return `连不上 ${repo.host}：${raw.trim().split('\n').at(-1)}`
  return `访问 ${where} 失败：${raw.trim().split('\n').at(-1) ?? ''}`
}

/**
 * 更新镜像：没有就建一个空的 bare 仓库，问远程的默认分支，把它 fetch 到 refs/remotes/origin/<分支>，返回它最新的提交。
 * 远程是空仓库（还没有提交）时报错。这次新建的镜像在失败时删掉。所有错误都是 MirrorError，消息是给用户看的中文。
 */
export const syncMirror = async (dataDir: string, repo: RemoteRepo, auth: { header?: string; credential: string; secret?: string }): Promise<Mirror> => {
  const gitDir = mirrorDir(dataDir, repo)
  const lockId = `mirror-${createHash('sha256').update(gitDir).digest('hex').slice(0, 16)}`
  const lock = acquire(join(resolve(dataDir), 'locks'), lockId)
  if ('heldBy' in lock) throw new MirrorError(`另一个进程（${lock.heldBy}）正在更新 ${repo.owner}/${repo.name} 的镜像，稍后再试`)
  const env = remoteEnv(repo, auth.header)
  const secrets = [auth.secret ?? '', auth.header?.replace(/^Authorization:\s*\w+\s+/i, '') ?? '']
  const git = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await run('git', [...SAFE, '--git-dir', gitDir, ...args], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: REMOTE_TIMEOUT_MS })
      return stdout.trim()
    } catch (e) {
      const err = e as { stderr?: unknown; killed?: boolean; message: string }
      const stderr = err.killed === true ? `timed out after ${REMOTE_TIMEOUT_MS / 60000} minutes` : String(err.stderr ?? err.message)
      throw new MirrorError(explain(repo, stderr, { credential: auth.credential, hasToken: auth.header !== undefined, secrets }))
    }
  }
  const fresh = !existsSync(join(gitDir, 'HEAD'))
  try {
    if (fresh) {
      mkdirSync(gitDir, { recursive: true })
      await run('git', ['init', '--bare', '-q', gitDir], { env })
    }
    // 输出形如 "ref: refs/heads/main\tHEAD\n<sha>\tHEAD"；空仓库什么都不输出。
    const head = await git(['ls-remote', '--symref', repo.cloneUrl, 'HEAD'])
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head)?.[1]
    if (branch === undefined) throw new MirrorError(`${repo.owner}/${repo.name} 还没有任何提交（空仓库），先推一个提交上去`)
    await git(['fetch', '-q', '--no-tags', repo.cloneUrl, `+refs/heads/${branch}:refs/remotes/origin/${branch}`])
    return { gitDir, branch, baseSha: await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`]) }
  } catch (e) {
    if (fresh) rmSync(gitDir, { recursive: true, force: true })
    throw e
  } finally {
    lock.release()
  }
}
