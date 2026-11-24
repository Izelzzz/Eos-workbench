// 一个进程里的任务执行者：创建任务、加锁运行、开发回复后提交改动。命令行和 Web 服务共用它，
// 同一个任务靠锁文件保证只有一个 runner（不管它在哪个进程里）。
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Conventions } from '../conventions/conventions.ts'
import { redactDeep, rememberSecret } from '../credentials/redact.ts'
import type { CheckResult, Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import { role as roleOf, type Check } from '../workflow/types.ts'
import { runChecks } from './checks.ts'
import { KILL_WAIT_MS, killProcessesIn } from './procs.ts'
import type { Credentials } from '../credentials/store.ts'
import { LOCAL_OWNER } from '../credentials/types.ts'
import { defaultForges, looksRemote, parseRemote } from '../forge/forges.ts'
import { ForgeError, NotInstalled, type Forge, type RemoteRepo } from '../forge/types.ts'
import { addWorktree, commitInScope, contextFor, createWorktree, scopeOfBranch, type Worktree } from './git.ts'
import { MirrorError, pushBranch, type RemoteAuth, remoteDefaultBranch, scrub, secretsOf, syncMirror } from './mirror.ts'
import { acquire, holder } from './lock.ts'
import { appendLog, taskLogPath } from './logs.ts'
import { runTask } from './runner.ts'

export type CreateInput = { repo: string; workflow: string; request: string }
export type Created = { ok: true; id: string } | { ok: false; error: string }
export type Started = { ok: true; done: Promise<Task> } | { ok: false; error: string }

/** PR 的标题：需求的第一行，最长 72 个字。 */
export const prTitle = (request: string): string => {
  const first = request.trim().split('\n')[0]!.trim()
  return first.length <= 72 ? first : `${first.slice(0, 71)}…`
}

/** PR 的说明：需求原文，加上是哪个任务开的。 */
export const prBody = (request: string, id: string, branch: string): string =>
  `${request.trim()}\n\n---\n由 Eos 平台开的 PR：任务 ${id}，分支 ${branch}。代码由 agent 编写，平台推送；合并前请评审。`

export const newId = (): string => `t${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}${Math.random().toString(36).slice(2, 5)}`

const isRepo = (path: string): boolean => existsSync(join(path, '.git'))

export class Supervisor {
  private readonly active = new Map<string, Promise<Task>>()
  readonly locksDir: string
  readonly conventions: Conventions
  private readonly forges: Forge[]

  constructor(private readonly o: {
    store: Store
    executor: Executor
    dataDir: string
    /** 记在事件里的发起方：命令行或 Web 页面。 */
    actor?: 'cli' | 'web'
    /** 每个任务的进度行。 */
    log?: (id: string, line: string) => void
    pollMs?: number
    /** 遮蔽已知凭据值：日志行和检查输出写下来之前都经过它。agent 的输出由包了 redacting 的执行器遮蔽。 */
    redact?: (text: string) => string
    /** 访问远程仓库用的令牌从这里取；不给时只能访问公开仓库。 */
    credentials?: Credentials
    /** 认得的代码托管平台，默认只有 github.com。 */
    forges?: Forge[]
  }) {
    this.locksDir = join(o.dataDir, 'locks')
    // 托管平台只建一次：GitHub App 的安装令牌缓存在它里面。
    this.forges = o.forges ?? defaultForges()
    this.conventions = new Conventions(o.store)
    this.conventions.seed(Date.now())
  }

  /**
   * 校验输入、建 worktree、写入存储。所有错误都是给用户看的中文。
   * repo 可以是平台所在机器上的 git 仓库路径，或托管平台上的仓库地址（例如 https://github.com/<owner>/<repo>）：
   * 远程仓库先更新平台数据目录里的镜像，在默认分支的最新提交上建 worktree。
   */
  async create(input: CreateInput): Promise<Created> {
    const request = input.request.trim()
    if (request === '') return { ok: false, error: '需求不能为空' }
    const where = input.repo.trim()
    if (where === '') return { ok: false, error: '需要仓库：平台所在机器上的路径，或 https://github.com/<owner>/<repo>' }
    const remote = parseRemote(this.forges, where)
    if (remote === undefined && looksRemote(where)) return { ok: false, error: `认不出仓库地址：${where}。目前支持 https://github.com/<owner>/<repo>（或 git@github.com:<owner>/<repo>.git）` }
    const repo = resolve(where)
    if (remote === undefined && (!existsSync(repo) || !statSync(repo).isDirectory())) return { ok: false, error: `找不到目录：${input.repo}` }
    if (remote === undefined && !isRepo(repo)) return { ok: false, error: `不是 git 仓库：${repo}` }
    // 先校验工作流，再访问网络。
    const resolved = this.conventions.resolve(input.workflow.trim())
    if (!resolved.ok) return resolved
    const id = newId()
    let w: Worktree
    let baseBranch: string | undefined
    try {
      if (remote === undefined) w = createWorktree(repo, this.o.dataDir, id)
      else {
        const m = await this.syncRemote(remote.repo, remote.forge)
        if (!m.ok) return m
        w = addWorktree(m.gitDir, m.baseSha, this.o.dataDir, id)
        baseBranch = m.branch
      }
    } catch (e) {
      const msg = String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()
      return { ok: false, error: `创建 worktree 失败：${msg.split('\n')[0]}` }
    }
    this.o.store.create({ id, request, context: contextFor(w), workflow: resolved.workflow, workflowSource: resolved.source, docs: resolved.docs,
      meta: { ...w, ...(remote === undefined ? {} : { remote: remote.repo }), ...(baseBranch === undefined ? {} : { baseBranch }), conventions: resolved.used, skills: resolved.skills } }, Date.now(), this.o.actor ?? 'cli')
    return { ok: true, id }
  }

  /**
   * 访问这个仓库用的认证，按顺序：托管平台的 App（装到了这个仓库）→ 凭据存储里的令牌 → 匿名。
   * App 只在"没装到这个仓库"时退回令牌。配了 App 但它出错（凭据读不出来、私钥不对、接口超时……）时返回 fatal：
   * 不悄悄换成个人令牌的身份，也不匿名再试（匿名失败的提示会叫人去加令牌，误导）。
   * error：没用上的凭据和原因，失败时附在报错后面；令牌真的用上了时，不附"App 没装"。
   */
  private async authFor(repo: RemoteRepo, forge: Forge): Promise<{ auth: RemoteAuth; error?: string } | { fatal: string }> {
    let notInstalled: string | undefined
    const appName = forge.appCredentialName?.(repo)
    if (appName !== undefined && forge.appToken !== undefined && this.o.credentials !== undefined) {
      const app = this.o.credentials.get(LOCAL_OWNER, appName)
      if (app.kind === 'error') return { fatal: app.error }
      if (app.kind === 'ok') {
        try {
          const token = await forge.appToken(repo, { name: appName, value: app.value })
          rememberSecret(token)
          return { auth: { credential: appName, header: forge.gitAuthHeader(token), secret: token } }
        } catch (e) {
          if (e instanceof NotInstalled) notInstalled = e.message
          else if (e instanceof ForgeError) return { fatal: e.message }
          else throw e
        }
      }
    }
    const credential = forge.credentialName(repo)
    const got = this.o.credentials?.get(LOCAL_OWNER, credential) ?? { kind: 'absent' as const }
    if (got.kind === 'ok') return { auth: { credential, header: forge.gitAuthHeader(got.value), secret: got.value } }
    const notes = [notInstalled, got.kind === 'error' ? got.error : undefined].filter((x): x is string => x !== undefined)
    return { auth: { credential }, ...(notes.length === 0 ? {} : { error: notes.join('；') }) }
  }

  /** 用 App 令牌访问失败：作废这个仓库缓存的令牌，人改了 App 的安装或权限之后重试，不用等旧令牌过期。 */
  private forgetIfApp(repo: RemoteRepo, forge: Forge, auth: RemoteAuth): void {
    if (auth.credential === forge.appCredentialName?.(repo)) forge.forgetAppToken?.(repo)
  }


  /** 任务的远程仓库对应的托管平台：按记下的种类和地址找回来。 */
  private forgeOf(repo: RemoteRepo): Forge | undefined {
    return this.forges.find(f => f.kind === repo.forge && f.parse(repo.webUrl) !== undefined)
  }

  /**
   * 平台动作：先核对并推送任务分支；pull-request 再向任务的基线分支开 PR（已经有就复用）。
   * 本机仓库的任务没有远程，算通过并写明原因。所有失败都写成给人看的原因（引擎不会把它交回 agent）。
   */
  private async platform(id: string, c: Extract<Check, { kind: 'platform' }>): Promise<CheckResult> {
    const meta = this.o.store.meta(id)
    if (meta.remote === undefined) return { check: c, passed: true, detail: `任务用的是本机仓库 ${meta.repo}，没有远程仓库，跳过${c.action === 'push' ? '推送' : '推送和开 PR'}` }
    const forge = this.forgeOf(meta.remote)
    if (forge === undefined) return { check: c, passed: false, detail: `平台不认得任务的远程仓库 ${meta.remote.webUrl}（${meta.remote.forge}）` }
    const fail = (detail: string): CheckResult => ({ check: c, passed: false, detail })
    // agent 能在 worktree 里自己提交：推送前按整个任务分支核对，改到的文件都要在可写角色的范围内。
    const task = this.o.store.get(id)!
    const writable = Object.values(task.workflow.roles).filter(r => r.write === 'worktree').flatMap(r => r.writePaths)
    let scope: ReturnType<typeof scopeOfBranch>
    try {
      scope = scopeOfBranch(meta, writable)
    } catch (e) {
      return fail(`核对任务分支失败，没有推送：${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim().split('\n')[0]}`)
    }
    if ('error' in scope) return fail(scope.error)
    const { outside } = scope
    if (outside.length > 0) {
      return fail(`任务分支的提交里有改动不在可写范围（${writable.join('、') || '没有可写的角色'}）内：${outside.slice(0, 20).join('、')}${outside.length > 20 ? ` 等 ${outside.length} 个` : ''}。这些提交不是平台做的，没有推送；请人工检查这个任务的分支`)
    }
    const got = await this.authFor(meta.remote, forge)
    if ('fatal' in got) return fail(`没有推送：${got.fatal}`)
    const { auth, error } = got
    const withCredential = (message: string) => (error === undefined ? message : `${message}（没用上的凭据：${error}）`)
    let sha: string
    try {
      sha = (await pushBranch(this.o.dataDir, meta.remote, auth, meta.branch, scope.sha)).sha
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e
      this.forgetIfApp(meta.remote, forge, auth)
      return fail(withCredential(e.message))
    }
    const branchUrl = forge.branchUrl(meta.remote, meta.branch)
    const branchLink = { label: `分支 ${meta.branch}`, url: branchUrl, kind: 'branch' as const }
    const pushed = `已把分支 ${meta.branch}（${sha.slice(0, 12)}）推到 ${branchUrl}`
    if (c.action === 'push') return { check: c, passed: true, detail: pushed, links: [branchLink] }
    // 旧版本建的任务没有记下默认分支：现在去问一次远程。
    let base = meta.baseBranch
    if (base === undefined) {
      try {
        base = await remoteDefaultBranch(this.o.dataDir, meta.remote, auth)
      } catch (e) {
        if (!(e instanceof MirrorError)) throw e
        return { ...fail(withCredential(`${pushed}，但不知道往哪个分支开 PR：${e.message}`)), links: [branchLink] }
      }
    }
    try {
      const pr = await forge.openPullRequest(meta.remote, auth.secret, { credential: auth.credential, head: meta.branch, base, sha, title: prTitle(task.request), body: prBody(task.request, id, meta.branch) })
      if ('merged' in pr) {
        return { check: c, passed: true, detail: `${pushed}。这个提交已经通过 PR #${pr.merged.number} 合并了：${pr.merged.url}`, links: [branchLink, { label: `PR #${pr.merged.number}（已合并）`, url: pr.merged.url, kind: 'pull-request' }] }
      }
      if ('empty' in pr) return { check: c, passed: true, detail: `${pushed}。任务分支和 ${base} 没有差别，没有开 PR`, links: [branchLink] }
      return {
        check: c, passed: true, detail: `${pushed}。${pr.reused ? '复用已经打开的' : '已开'} PR #${pr.number}：${pr.url}`,
        links: [branchLink, { label: `PR #${pr.number}`, url: pr.url, kind: 'pull-request' }],
      }
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e
      this.forgetIfApp(meta.remote, forge, auth)
      return { ...fail(withCredential(`${pushed}，但开 PR 失败：${scrub(e.message, secretsOf(auth))}`)), links: [branchLink] }
    }
  }

  /** 按 authFor 的顺序取认证（App → 令牌 → 匿名），更新镜像；失败时把没用上的凭据和原因附在后面。 */
  private async syncRemote(repo: RemoteRepo, forge: Forge): Promise<{ ok: true; gitDir: string; baseSha: string; branch: string } | { ok: false; error: string }> {
    const got = await this.authFor(repo, forge)
    if ('fatal' in got) return { ok: false, error: got.fatal }
    const { auth, error } = got
    try {
      const m = await syncMirror(this.o.dataDir, repo, auth)
      return { ok: true, gitDir: m.gitDir, baseSha: m.baseSha, branch: m.branch }
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e
      this.forgetIfApp(repo, forge, auth)
      return { ok: false, error: error === undefined ? e.message : `${e.message}（没用上的凭据：${error}）` }
    }
  }

  /** 这个任务的日志文件（数据目录下的 logs/<任务>.log）。 */
  logPath(id: string): string {
    return taskLogPath(this.o.dataDir, id)
  }

  /** 这个任务现在有没有 runner（本进程或别的进程）。 */
  running(id: string): boolean {
    return this.active.has(id) || holder(this.locksDir, id) !== undefined
  }

  /** 在本进程里开始运行（或续跑）任务。已经有 runner 时不重复启动。 */
  start(id: string, opts: { wait?: boolean } = {}): Started {
    if (this.o.store.get(id) === undefined) return { ok: false, error: `没有任务 ${id}` }
    if (this.active.has(id)) return { ok: false, error: '任务已经在运行' }
    const lock = acquire(this.locksDir, id)
    if ('heldBy' in lock) return { ok: false, error: `任务正在被进程 ${lock.heldBy} 运行` }
    // 进度行既交给调用方（终端），也写进数据目录下的 logs/<任务>.log；详细错误只写文件。
    const logPath = this.logPath(id)
    const redact = this.o.redact ?? (s => s)
    const log = (raw: string) => {
      const line = redact(raw)
      appendLog(logPath, line)
      this.o.log?.(id, line)
    }
    appendLog(logPath, `runner 开始（进程 ${process.pid}，${this.o.actor ?? 'cli'}）`)
    const done = runTask(id, {
      store: this.o.store, executor: this.o.executor, wait: opts.wait ?? true, log, detail: text => appendLog(logPath, redact(text)), redact,
      ...(this.o.pollMs === undefined ? {} : { pollMs: this.o.pollMs }),
      // 撤销越界改动之前：关掉这个 worktree 的 agent 进程（连同它的作业），再杀掉工作目录还在 worktree 里的残留进程
      // （Izelzzz/Eos-workbench#28）。下一次调用会重新启动 dsh、从会话日志续接。
      beforeRevert: async t => {
        const worktree = this.o.store.meta(t.id).worktree
        await this.o.executor.release(worktree)
        const killed = await killProcessesIn(worktree)
        if (killed.length > 0) log(`  结束了 ${killed.length} 个留在 worktree 里的进程：${killed.map(k => `${k.name}(${k.pid})`).join('、')}`)
        const stuck = killed.filter(k => !k.exited)
        if (stuck.length > 0) log(`  （警告：${stuck.map(k => `${k.name}(${k.pid})`).join('、')} 被结束后等了 ${KILL_WAIT_MS / 1000} 秒还没退出，照常撤销越界改动）`)
      },
      checker: async (t, run, signal) => redactDeep(await runChecks(this.o.store.meta(t.id).worktree, run.checks, process.env, signal, c => this.platform(t.id, c)), redact),
      afterWrite: (t, call) => {
        // 可写范围是角色的 writePaths；越界的改动在提交前撤销，不进历史。
        const { writePaths } = roleOf(t.workflow, call.role)
        const { sha, reverted } = commitInScope(this.o.store.meta(t.id).worktree, writePaths, `eos: ${call.node} ${call.purpose} (${call.id})`, this.o.store.meta(t.id).repo)
        if (reverted.length > 0) log(`  已撤销 ${reverted.length} 处越界改动：${reverted.join('、')}`)
        if (sha !== undefined) log(`  已提交 ${sha}`)
        return reverted
      },
    }).finally(async () => {
      // 先关掉这个任务的 agent 进程再放锁：worktree 各自一个进程，不释放会越积越多；
      // 旧进程还没退出时下一个 runner 续接会话，会撞上它占着的会话锁。
      try {
        await this.o.executor.release(this.o.store.meta(id).worktree)
      } catch (e) {
        log(`  （关闭 agent 进程失败：${(e as Error).message}）`)
      }
      lock.release()
      this.active.delete(id)
    })
    this.active.set(id, done)
    done.then(t => appendLog(logPath, `runner 结束：${t.status}`), e => {
      log(`✗ runner 出错：${(e as Error).message}`)
      appendLog(logPath, redact((e as Error).stack ?? String(e)))
    })
    return { ok: true, done }
  }

  /** 进行中、又没有 runner 的任务全部接着跑（Web 服务启动时用）。失败和已中止的不动。 */
  resumeAll(): string[] {
    return this.o.store.list()
      .filter(t => (t.status === 'running' || t.status === 'waiting_user') && !this.running(t.id))
      .flatMap(t => (this.start(t.id).ok ? [t.id] : []))
  }

  /** 等本进程里所有 runner 结束（测试和退出时用）。 */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()])
  }
}
