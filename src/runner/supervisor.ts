// 一个进程里的任务执行者：创建任务、加锁运行、开发回复后提交改动。命令行和 Web 服务共用它，
// 同一个任务靠锁文件保证只有一个 runner（不管它在哪个进程里）。
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Conventions } from '../conventions/conventions.ts'
import { redactDeep } from '../credentials/redact.ts'
import type { Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import { role as roleOf } from '../workflow/types.ts'
import { runChecks } from './checks.ts'
import { killProcessesIn } from './procs.ts'
import type { Credentials } from '../credentials/store.ts'
import { LOCAL_OWNER } from '../credentials/types.ts'
import { defaultForges, looksRemote, parseRemote } from '../forge/forges.ts'
import type { Forge, RemoteRepo } from '../forge/types.ts'
import { addWorktree, commitInScope, contextFor, createWorktree, type Worktree } from './git.ts'
import { MirrorError, syncMirror } from './mirror.ts'
import { acquire, holder } from './lock.ts'
import { appendLog, taskLogPath } from './logs.ts'
import { runTask } from './runner.ts'

export type CreateInput = { repo: string; workflow: string; request: string }
export type Created = { ok: true; id: string } | { ok: false; error: string }
export type Started = { ok: true; done: Promise<Task> } | { ok: false; error: string }

export const newId = (): string => `t${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}${Math.random().toString(36).slice(2, 5)}`

const isRepo = (path: string): boolean => existsSync(join(path, '.git'))

export class Supervisor {
  private readonly active = new Map<string, Promise<Task>>()
  readonly locksDir: string
  readonly conventions: Conventions

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
    const remote = parseRemote(this.o.forges ?? defaultForges(), where)
    if (remote === undefined && looksRemote(where)) return { ok: false, error: `认不出仓库地址：${where}。目前支持 https://github.com/<owner>/<repo>（或 git@github.com:<owner>/<repo>.git）` }
    const repo = resolve(where)
    if (remote === undefined && (!existsSync(repo) || !statSync(repo).isDirectory())) return { ok: false, error: `找不到目录：${input.repo}` }
    if (remote === undefined && !isRepo(repo)) return { ok: false, error: `不是 git 仓库：${repo}` }
    // 先校验工作流，再访问网络。
    const resolved = this.conventions.resolve(input.workflow.trim())
    if (!resolved.ok) return resolved
    const id = newId()
    let w: Worktree
    try {
      if (remote === undefined) w = createWorktree(repo, this.o.dataDir, id)
      else {
        const m = await this.syncRemote(remote.repo, remote.forge)
        if (!m.ok) return m
        w = addWorktree(m.gitDir, m.baseSha, this.o.dataDir, id)
      }
    } catch (e) {
      const msg = String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()
      return { ok: false, error: `创建 worktree 失败：${msg.split('\n')[0]}` }
    }
    this.o.store.create({ id, request, context: contextFor(w), workflow: resolved.workflow, workflowSource: resolved.source, docs: resolved.docs,
      meta: { ...w, ...(remote === undefined ? {} : { remote: remote.repo }), conventions: resolved.used, skills: resolved.skills } }, Date.now(), this.o.actor ?? 'cli')
    return { ok: true, id }
  }

  /**
   * 取这个仓库的令牌（凭据存储里没有就匿名访问），更新镜像。
   * 凭据存在但读不出来（没有主密钥、换了主密钥）时先匿名试一次：公开仓库照样能用；匿名也不行时两个原因都报出来。
   */
  private async syncRemote(repo: RemoteRepo, forge: Forge): Promise<{ ok: true; gitDir: string; baseSha: string } | { ok: false; error: string }> {
    const credential = forge.credentialName(repo)
    const got = this.o.credentials?.get(LOCAL_OWNER, credential) ?? { kind: 'absent' as const }
    const token = got.kind === 'ok' ? got.value : undefined
    try {
      const m = await syncMirror(this.o.dataDir, repo, { credential, ...(token === undefined ? {} : { header: forge.gitAuthHeader(token), secret: token }) })
      return { ok: true, gitDir: m.gitDir, baseSha: m.baseSha }
    } catch (e) {
      if (!(e instanceof MirrorError)) throw e
      return { ok: false, error: got.kind === 'error' ? `${e.message}（凭据「${credential}」读不出来，所以没带令牌：${got.error}）` : e.message }
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
      },
      checker: async (t, run, signal) => redactDeep(await runChecks(this.o.store.meta(t.id).worktree, run.checks, process.env, signal), redact),
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
