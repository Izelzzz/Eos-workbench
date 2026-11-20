// 一个进程里的任务执行者：创建任务、加锁运行、开发回复后提交改动。命令行和 Web 服务共用它，
// 同一个任务靠锁文件保证只有一个 runner（不管它在哪个进程里）。
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import { loadWorkflow } from '../workflow/templates.ts'
import { commitAll, contextFor, createWorktree } from './git.ts'
import { acquire, holder } from './lock.ts'
import { runTask } from './runner.ts'

export type CreateInput = { repo: string; workflow: string; request: string }
export type Created = { ok: true; id: string } | { ok: false; error: string }
export type Started = { ok: true; done: Promise<Task> } | { ok: false; error: string }

export const newId = (): string => `t${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}${Math.random().toString(36).slice(2, 5)}`

const isRepo = (path: string): boolean => existsSync(join(path, '.git'))

export class Supervisor {
  private readonly active = new Map<string, Promise<Task>>()
  readonly locksDir: string

  constructor(private readonly o: {
    store: Store
    executor: Executor
    dataDir: string
    /** 每个任务的进度行。 */
    log?: (id: string, line: string) => void
    pollMs?: number
  }) {
    this.locksDir = join(o.dataDir, 'locks')
  }

  /** 校验输入、建 worktree、写入存储。所有错误都是给用户看的中文。 */
  create(input: CreateInput): Created {
    const request = input.request.trim()
    if (request === '') return { ok: false, error: '需求不能为空' }
    const repo = resolve(input.repo.trim())
    if (input.repo.trim() === '' || !existsSync(repo) || !statSync(repo).isDirectory()) return { ok: false, error: `找不到目录：${input.repo}` }
    if (!isRepo(repo)) return { ok: false, error: `不是 git 仓库：${repo}` }
    let loaded: ReturnType<typeof loadWorkflow>
    try {
      loaded = loadWorkflow(input.workflow)
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
    const id = newId()
    let w: ReturnType<typeof createWorktree>
    try {
      w = createWorktree(repo, this.o.dataDir, id)
    } catch (e) {
      const msg = String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim()
      return { ok: false, error: `创建 worktree 失败：${msg.split('\n')[0]}` }
    }
    this.o.store.create({ id, request, context: contextFor(w), workflow: loaded.workflow, workflowSource: loaded.source, meta: w }, Date.now())
    return { ok: true, id }
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
    const log = (line: string) => this.o.log?.(id, line)
    const done = runTask(id, {
      store: this.o.store, executor: this.o.executor, wait: opts.wait ?? true, log,
      ...(this.o.pollMs === undefined ? {} : { pollMs: this.o.pollMs }),
      afterWrite: (t, call) => {
        const sha = commitAll(this.o.store.meta(t.id).worktree, `eos: ${call.node} ${call.purpose} (${call.id})`)
        if (sha !== undefined) log(`  已提交 ${sha}`)
      },
    }).finally(() => {
      lock.release()
      this.active.delete(id)
    })
    this.active.set(id, done)
    done.catch(e => log(`✗ runner 出错：${(e as Error).message}`))
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
