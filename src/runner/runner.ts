// runner：反复读取任务状态，执行 pending 的工作（agent 调用或检查），把结果作为事件写回存储。
// 状态只在存储里；runner 自己只记"哪个调用正在本进程里执行"。
import type { Call, CheckResult, CheckRun, Task } from '../engine/types.ts'
import { isCheck } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import { role as roleOf } from '../workflow/types.ts'

export type RunnerOptions = {
  store: Store
  executor: Executor
  now?: () => number
  pollMs?: number
  /** 对话尽头需要用户指示时：true 留在这里等回答，false 直接返回。 */
  wait?: boolean
  /** 写 worktree 的角色每次回复后调用（撤销越界改动并提交剩下的）。返回被撤销的越界路径。 */
  afterWrite?: (task: Task, call: Call) => string[] | void
  /** 执行一组检查（在任务的 worktree 里）。结果顺序与 run.checks 一致。 */
  checker?: (task: Task, run: CheckRun, signal: AbortSignal) => Promise<CheckResult[]>
  log?: (line: string) => void
}

export const keyOf = (taskId: string, session: string) => `${taskId}/${session}`
export const nonceOf = (taskId: string, call: Call) => `${taskId}/${call.id}`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const label = (task: Task, call: Call) =>
  `[${call.node}${task.dialog === undefined ? '' : ` 第 ${task.dialog.round} 轮`}] ${call.role} · ${call.purpose}`

export const runTask = async (id: string, o: RunnerOptions): Promise<Task> => {
  const now = o.now ?? Date.now
  const pollMs = o.pollMs ?? 1000
  const log = o.log ?? (() => {})
  const dispatch = (event: Parameters<Store['dispatch']>[1], actor: 'runner' | 'executor' = 'executor') => o.store.dispatch(id, event, now(), actor)

  /** agent 中途提问：记成问题，等 `eos answer` 写入回答。崩溃前已经提过的同一个问题直接复用。 */
  const waitForAnswer = async (call: Call, q: { id: string; text: string; options?: string[] }, signal: AbortSignal): Promise<string> => {
    // 排在队里时已经被取消的提问，不再提给用户。
    if (signal.aborted) throw new Error('提问被取消')
    const step = dispatch({ kind: 'asked', call: call.id, question: q })
    const current = step.task.question
    // 被接受：新问题（可能替换了上一次运行留下的旧问题）；被拒绝但同一调用的问题还开着：就是同一个问题，接着等它的回答。
    const qid = step.accepted ? current!.id : current?.call === call.id ? current.id : undefined
    if (qid === undefined) throw new Error(`无法记录提问：${step.reason}`)
    log(`？ agent 提问（${qid}）：${q.text}${q.options ? `（选项：${q.options.join(' / ')}）` : ''}\n  在任务页面上回答，或用 eos answer ${id} "<回答>"`)
    for (;;) {
      if (signal.aborted) throw new Error('提问被取消')
      const t = o.store.get(id)!
      const answer = t.log.find(e => e.type === 'answer' && e.questionId === qid)
      if (answer?.type === 'answer') return answer.text
      if (t.status === 'aborted') throw new Error('任务已中止')
      await sleep(pollMs)
    }
  }

  const execute = async (task: Task, call: Call): Promise<void> => {
    const role = roleOf(task.workflow, call.role)
    const key = keyOf(id, call.session)
    const nonce = nonceOf(id, call)
    const recovered = await o.executor.findReply(key, nonce)
    if (recovered !== undefined) {
      log(`↺ ${label(task, call)}：会话里已有这次调用的回复，直接使用`)
      // 崩溃前那次运行的事件流可能没记全：已有的保留，没有就从会话日志回放。
      if (!o.store.hasTrace(id, call.id)) o.store.appendTrace(id, call.id, await o.executor.traceOf(key, nonce))
    } else log(`→ ${label(task, call)}`)
    let reply = recovered
    let asking: Promise<unknown> = Promise.resolve()
    if (reply === undefined) {
      const meta = o.store.meta(id)
      // 这个角色能看到的技能：只有它自己列出来的，内容用任务创建时的快照（平台上之后的修改不影响正在跑的任务）。
      const skills = (meta.skills ?? []).filter(s => role.skills.includes(s.name)).map(s => ({ name: s.name, content: s.content }))
      // 角色写了技能名但任务快照里没有：agent 会少一份本该有的说明，结果看着正常却是错的，所以记一行。
      const missing = role.skills.filter(name => !skills.some(s => s.name === name))
      if (missing.length > 0) log(`  （警告：角色 ${call.role} 要的技能 ${missing.join('、')} 不在任务快照里，这次调用看不到它们）`)
      o.store.appendTrace(id, call.id, [{ kind: 'call_start', t: now(), call: { node: call.node, role: call.role, purpose: call.purpose, prompt: call.prompt } }])
      try {
        reply = await o.executor.send({
          key, nonce, prompt: call.prompt,
          onEvent: e => {
            // trace 只是观测数据：写不进去（例如数据库忙）也不能打断 agent 的调用。
            try {
              o.store.appendTrace(id, call.id, [e])
            } catch (err) {
              log(`  （trace 记录失败：${(err as Error).message}）`)
            }
          },
          spec: {
            model: role.model, ...(role.effort === undefined ? {} : { effort: role.effort }), write: role.write, cwd: meta.worktree,
            profile: { denyTools: role.denyTools, skills, mcp: role.mcp },
          },
          // 同一次调用里的提问排队：一个问题答完才提出下一个，不会出现第二个问题替换掉还在等回答的第一个。
          ask: (q, signal) => {
            const next = asking.then(() => waitForAnswer(call, q, signal))
            asking = next.catch(() => undefined)
            return next
          },
        })
      } catch (e) {
        log(`✗ ${label(task, call)}：${(e as Error).message}`)
        dispatch({ kind: 'call_failed', call: call.id, error: (e as Error).message })
        return
      }
    }
    let reverted: string[] = []
    if (role.write === 'worktree') {
      try {
        reverted = o.afterWrite?.(task, call) ?? []
      } catch (e) {
        // 改动没提交上（例如 worktree 被删了）：这次调用记为失败，任务停下等人工处理，而不是让 runner 悄悄退出。
        const error = `提交改动失败：${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim().split('\n')[0]}`
        log(`✗ ${label(task, call)}：${error}`)
        dispatch({ kind: 'call_failed', call: call.id, error })
        return
      }
    }
    const u = reply.usage
    log(`✓ ${label(task, call)}：${(reply.ms / 1000).toFixed(1)}s，输入 ${u.input}，输出 ${u.output}，缓存读 ${u.cacheRead}`)
    dispatch({ kind: 'replied', call: call.id, sessionId: reply.sessionId, text: reply.text, usage: reply.usage, ms: reply.ms,
      ...(reply.model === undefined ? {} : { model: reply.model }), ...(reverted.length === 0 ? {} : { reverted }) })
  }

  /** 检查没有副作用，崩溃后直接重跑即可，不需要像调用那样认领。 */
  const check = async (task: Task, run: CheckRun): Promise<void> => {
    const where = `[${run.node}${task.dialog === undefined ? '' : ` 第 ${task.dialog.round} 轮`}] 检查`
    if (o.checker === undefined) {
      dispatch({ kind: 'call_failed', call: run.id, error: '没有配置检查执行器' })
      return
    }
    log(`→ ${where}（${run.checks.length} 项）`)
    const started = now()
    // 检查进行中任务被中止：结束检查命令，不让它以平台的权限一直跑到超时。
    const aborter = new AbortController()
    const watch = setInterval(() => {
      if (o.store.get(id)?.status === 'aborted') aborter.abort()
    }, pollMs)
    let results: CheckResult[]
    try {
      results = await o.checker(task, run, aborter.signal)
    } catch (e) {
      clearInterval(watch)
      log(`✗ ${where}：${(e as Error).message}`)
      dispatch({ kind: 'call_failed', call: run.id, error: `检查无法执行：${(e as Error).message}` })
      return
    }
    clearInterval(watch)
    log(`${results.every(r => r.passed) ? '✓' : '✗'} ${where}：${results.filter(r => r.passed).length}/${results.length} 项通过`)
    dispatch({ kind: 'checked', call: run.id, results, ms: now() - started })
  }

  for (;;) {
    const task = o.store.get(id)
    if (task === undefined) throw new Error(`没有任务 ${id}`)
    if (task.status === 'done' || task.status === 'aborted' || task.status === 'failed') return task
    if (task.pending !== undefined) {
      if (isCheck(task.pending)) await check(task, task.pending)
      else await execute(task, task.pending)
      continue
    }
    // 只剩一种情况：对话尽头在等用户指示。
    if (!o.wait) return task
    await sleep(pollMs)
  }
}
