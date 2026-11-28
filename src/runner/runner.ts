// runner：反复读取任务状态，执行 pending 的工作（agent 调用或检查），把结果作为事件写回存储。
// 状态只在存储里；runner 自己只记"哪个调用正在本进程里执行"。
import type { Call, CheckResult, CheckRun, Task } from '../engine/types.ts'
import { isCheck } from '../engine/types.ts'
import type { AgentProfile, Executor } from '../executor/types.ts'
import type { Store } from '../store/store.ts'
import { role as roleOf, type Role } from '../workflow/types.ts'
import { explain } from '../engine/failure.ts'
import { describePosition } from '../engine/machine.ts'

/**
 * 任务里一个角色的能力面（技能另外按任务快照给）。runner 交给执行器的、建任务时核对执行器做不做得到的，都用这一份。
 * background：可写的角色不能起后台作业（见 AgentProfile 的 background）。
 */
export const roleProfile = (role: Pick<Role, 'write' | 'denyTools' | 'mcp'>): Omit<AgentProfile, 'skills'> => ({
  builtinTools: 'standard',
  denyTools: role.denyTools,
  mcp: role.mcp,
  background: role.write !== 'worktree',
})

export type RunnerOptions = {
  store: Store
  executor: Executor
  now?: () => number
  pollMs?: number
  /** 对话尽头需要用户指示时：true 留在这里等回答，false 直接返回。 */
  wait?: boolean
  /** 写 worktree 的角色每次回复后调用（撤销越界改动并提交剩下的）。返回被撤销的越界路径。 */
  afterWrite?: (task: Task, call: Call) => string[] | void
  /** 写 worktree 的角色每次回复后、afterWrite 之前调用：结束这一轮留下的 agent 进程，撤销越界改动时不能有人在改 worktree。 */
  beforeRevert?: (task: Task, call: Call) => Promise<void>
  /** 执行一组检查（在任务的 worktree 里）。结果顺序与 run.checks 一致。 */
  checker?: (task: Task, run: CheckRun, signal: AbortSignal) => Promise<CheckResult[]>
  log?: (line: string) => void
  /** 只写进日志文件、不打到终端的详细信息（错误的完整输出和堆栈）。 */
  detail?: (text: string) => void
  /** 遮蔽已知凭据值：失败原因存进任务之前经过它（git、检查命令的报错可能带着凭据）。 */
  redact?: (text: string) => string
}

/** 错误的完整信息：git 的 stderr、错误文字、堆栈。只进日志文件。 */
const fullError = (e: unknown): string => {
  const stderr = (e as { stderr?: unknown }).stderr
  return [stderr === undefined ? '' : `stderr：${String(stderr).trim()}`, e instanceof Error ? (e.stack ?? e.message) : String(e)].filter(x => x !== '').join('\n')
}

/** 原因取一行：git 常在 fatal/error 前面先打提示或警告，有 fatal/error 行就用它，否则用第一行。 */
const keyLine = (text: string): string => {
  const lines = text.trim().split('\n')
  return (lines.find(l => /^(fatal|error):/i.test(l.trim())) ?? lines[0]!).trim()
}

export const keyOf = (taskId: string, session: string) => `${taskId}/${session}`
export const nonceOf = (taskId: string, call: Call) => `${taskId}/${call.id}`

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 第几轮评审，或第几次验收。 */
const roundOf = (task: Task): string => (task.gate !== undefined ? ` 第 ${task.gate.round} 次` : task.dialog === undefined ? '' : ` 第 ${task.dialog.round} 轮`)

const label = (task: Task, call: Call) => `[${call.node}${roundOf(task)}] ${call.role} · ${call.purpose}`

export const runTask = async (id: string, o: RunnerOptions): Promise<Task> => {
  const now = o.now ?? Date.now
  const pollMs = o.pollMs ?? 1000
  const log = o.log ?? (() => {})
  const dispatch = (event: Parameters<Store['dispatch']>[1], actor: 'runner' | 'executor' = 'executor') => o.store.dispatch(id, event, now(), actor)
  /** 这一步失败：终端打一行，日志文件记完整信息，任务的失败原因写清哪一步、什么原因、怎么修。 */
  const fail = (where: string, callId: Call['id'] | CheckRun['id'], reason: string, e?: unknown, fix?: string) => {
    const first = (o.redact ?? (t => t))(reason.trim().split('\n')[0]!)
    log(`✗ ${where}：${first}`)
    if (e !== undefined) o.detail?.(`✗ ${where} 的完整错误：\n${fullError(e)}`)
    dispatch({ kind: 'call_failed', call: callId, error: explain({ where, error: first, task: id, ...(fix === undefined ? {} : { fix }) }) })
  }

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
    // 找回时交给这次调用该用的执行器：角色在任务的工作流快照里，之后改模板不影响（旧任务的角色没写，用默认执行器）
    const recovered = await o.executor.findReply(key, nonce, role.executor)
    if (recovered !== undefined) {
      log(`↺ ${label(task, call)}：会话里已有这次调用的回复，直接使用`)
      // 崩溃前那次运行的事件流可能没记全：已有的保留，没有就从会话日志回放。
      if (!o.store.hasTrace(id, call.id)) o.store.appendTrace(id, call.id, await o.executor.traceOf(key, nonce, role.executor))
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
          key,
          nonce,
          prompt: call.prompt,
          onEvent: e => {
            // trace 只是观测数据：写不进去（例如数据库忙）也不能打断 agent 的调用。
            try {
              o.store.appendTrace(id, call.id, [e])
            } catch (err) {
              log(`  （trace 记录失败：${(err as Error).message}）`)
            }
          },
          spec: {
            ...(role.executor === undefined ? {} : { executor: role.executor }),
            ...(role.model === undefined ? {} : { model: role.model }),
            ...(role.effort === undefined ? {} : { effort: role.effort }),
            write: role.write,
            cwd: meta.worktree,
            profile: { ...roleProfile(role), skills },
          },
          // 同一次调用里的提问排队：一个问题答完才提出下一个，不会出现第二个问题替换掉还在等回答的第一个。
          ask: (q, signal) => {
            const next = asking.then(() => waitForAnswer(call, q, signal))
            asking = next.catch(() => undefined)
            return next
          },
        })
      } catch (e) {
        const reason = keyLine((e as Error).message)
        // 这个角色用的执行器认得这个错误时，修法由它给（具体到它的 key、模型接口）
        fail(`${label(task, call)}（调用 ${call.id}）`, call.id, reason, e, o.executor.failureHint?.(reason, role.executor))
        return
      }
    }
    let reverted: string[] = []
    if (role.write === 'worktree') {
      try {
        await o.beforeRevert?.(task, call)
        reverted = o.afterWrite?.(task, call) ?? []
      } catch (e) {
        // 改动没提交上（例如 worktree 被删了）：这次调用记为失败，任务停下等人工处理，而不是让 runner 悄悄退出。
        fail(`${label(task, call)}（调用 ${call.id}）`, call.id, `提交改动失败：${keyLine(String((e as { stderr?: unknown }).stderr ?? (e as Error).message))}`, e)
        return
      }
    }
    const u = reply.usage
    log(`✓ ${label(task, call)}：${(reply.ms / 1000).toFixed(1)}s，输入 ${u.input}，输出 ${u.output}，缓存读 ${u.cacheRead}`)
    dispatch({
      kind: 'replied',
      call: call.id,
      sessionId: reply.sessionId,
      text: reply.text,
      usage: reply.usage,
      ms: reply.ms,
      ...(reply.model === undefined ? {} : { model: reply.model }),
      ...(reverted.length === 0 ? {} : { reverted }),
    })
  }

  /**
   * 检查崩溃后直接重跑，不像调用那样认领。命令检查没有副作用；平台动作必须做成重复执行结果相同
   * （推送同一个分支：已经推上去时什么都不变；开 PR：已经有就复用）。
   */
  const check = async (task: Task, run: CheckRun): Promise<void> => {
    const where = `[${run.node}${roundOf(task)}] 检查`
    if (o.checker === undefined) {
      fail(where, run.id, '没有配置检查执行器')
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
      fail(where, run.id, `检查无法执行：${keyLine((e as Error).message)}`, e)
      return
    }
    clearInterval(watch)
    log(`${results.every(r => r.passed) ? '✓' : '✗'} ${where}：${results.filter(r => r.passed).length}/${results.length} 项通过`)
    dispatch({ kind: 'checked', call: run.id, results, ms: now() - started })
  }

  /** 这一次等验收已经打过提示了：同一次（卡点、第几次、已有几条记录）只打一行。 */
  let announced: string | undefined
  for (;;) {
    const task = o.store.get(id)
    if (task === undefined) throw new Error(`没有任务 ${id}`)
    if (task.status === 'done' || task.status === 'aborted' || task.status === 'failed') return task
    if (task.pending !== undefined) {
      if (isCheck(task.pending)) await check(task, task.pending)
      else await execute(task, task.pending)
      continue
    }
    // 只剩两种情况：对话尽头在等用户指示，或停在卡点上等人验收。两种都不挂工作，状态在存储里，进程重启后原样读回。
    if (task.status === 'waiting_accept' && task.gate !== undefined) {
      const at = `${task.gate.node}#${task.gate.round}#${task.log.length}`
      if (announced !== at) {
        announced = at
        log(`⏸ 等待验收（${task.gate.node} 第 ${task.gate.round} 次）：${describePosition(task)}\n  通过：eos accept ${id} ["<备注>"]；打回：eos send-back ${id} "<意见>"`)
      }
    }
    if (!o.wait) return task
    await sleep(pollMs)
  }
}
