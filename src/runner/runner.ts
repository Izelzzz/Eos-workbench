// runner：反复读取任务状态，执行 pending 的调用，把结果作为事件写回存储。
// 状态只在存储里；runner 自己只记"哪个调用正在本进程里执行"。
import type { Call, Task } from '../engine/types.ts'
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
  /** 写 worktree 的角色每次回复后调用（提交改动）。 */
  afterWrite?: (task: Task, call: Call) => void
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
    const step = dispatch({ kind: 'asked', call: call.id, question: q })
    const current = step.task.question
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
    if (reply === undefined) {
      o.store.appendTrace(id, call.id, [{ kind: 'call_start', t: now() }])
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
          spec: { model: role.model, ...(role.effort === undefined ? {} : { effort: role.effort }), write: role.write, cwd: o.store.meta(id).worktree },
          ask: (q, signal) => waitForAnswer(call, q, signal),
        })
      } catch (e) {
        log(`✗ ${label(task, call)}：${(e as Error).message}`)
        dispatch({ kind: 'call_failed', call: call.id, error: (e as Error).message })
        return
      }
    }
    if (role.write === 'worktree') {
      try {
        o.afterWrite?.(task, call)
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
    dispatch({ kind: 'replied', call: call.id, sessionId: reply.sessionId, text: reply.text, usage: reply.usage, ms: reply.ms, ...(reply.model === undefined ? {} : { model: reply.model }) })
  }

  for (;;) {
    const task = o.store.get(id)
    if (task === undefined) throw new Error(`没有任务 ${id}`)
    if (task.status === 'done' || task.status === 'aborted' || task.status === 'failed') return task
    if (task.pending !== undefined) {
      await execute(task, task.pending)
      continue
    }
    // 只剩一种情况：对话尽头在等用户指示。
    if (!o.wait) return task
    await sleep(pollMs)
  }
}
