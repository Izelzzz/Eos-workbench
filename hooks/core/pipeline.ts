// 流水线的纯逻辑：阶段定义与状态机。不依赖引擎（$），可单独测试。
import type { StageId, StageRun, Task, Tokens } from '../../types'

export type StageDef = {
  id: StageId
  label: string
  /** after：本阶段完成后等人工批准；before：开始前等人工批准。 */
  gate?: 'before' | 'after'
}

export const STAGES: readonly StageDef[] = [
  { id: 'spec', label: '需求 Spec', gate: 'after' },
  { id: 'dev', label: '代码开发' },
  { id: 'test', label: '单元测试' },
  { id: 'review', label: 'Code Review' },
  { id: 'merge', label: '合并', gate: 'before' },
  { id: 'deploy', label: '发布部署', gate: 'before' },
]

export const stageDef = (id: StageId): StageDef =>
  STAGES.find(s => s.id === id) ?? { id, label: id }

/** 状态机需要知道的配置。 */
export type MachineConfig = {
  maxRework: number
  hasTest: boolean
  hasDeploy: boolean
}

/** 状态机产生的下一步动作，由引擎层执行。 */
export type Action =
  | { kind: 'run'; stage: StageId }
  | { kind: 'wait'; stage: StageId }
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'none'; reason?: string }

export type Event =
  | { kind: 'progress'; stage: StageId; durationMs: number; tokens?: Tokens; model?: string }
  | { kind: 'finished'; stage: StageId; ok: boolean; note?: string; durationMs: number; tokens?: Tokens; model?: string }
  | { kind: 'approve' }
  | { kind: 'reject'; reason: string }
  | { kind: 'retry' }
  | { kind: 'abort' }

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

const addTokens = (a: Tokens, b?: Tokens): Tokens =>
  b === undefined
    ? a
    : {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
      }

export const emptyRun = (stage: StageId): StageRun => ({
  stage,
  status: 'pending',
  attempts: 0,
  durationMs: 0,
  waitMs: 0,
  tokens: zeroTokens(),
  artifacts: [],
})

/**
 * 子 agent 是否真正结束。留有后台任务的 agent 在 turn 结束时是 waiting，
 * 之后还会被唤醒；列表里查不到也算结束，避免阶段永远挂起。
 */
export const isFinalAgentStatus = (status: string | undefined): boolean =>
  status === undefined || status === 'completed' || status === 'failed' || status === 'killed'

export const isTerminal = (t: Task): boolean =>
  t.status === 'done' || t.status === 'failed' || t.status === 'aborted'

type Step = { task: Task; action: Action }

const setStage = (task: Task, id: StageId, patch: Partial<StageRun>): Task => ({
  ...task,
  stages: { ...task.stages, [id]: { ...task.stages[id], ...patch } },
})

/** 让某阶段开始运行（引擎层随后真正执行它）。 */
const begin = (task: Task, id: StageId, now: number): Step => {
  const run = task.stages[id]
  const waited = run.waitingSince === undefined ? 0 : now - run.waitingSince
  const next = setStage({ ...task, status: 'running', current: id }, id, {
    status: 'running',
    attempts: run.attempts + 1,
    startedAt: now,
    waitingSince: undefined,
    waitMs: run.waitMs + waited,
    agentId: undefined,
  })
  return { task: next, action: { kind: 'run', stage: id } }
}

const wait = (task: Task, id: StageId, now: number): Step => ({
  task: setStage({ ...task, status: 'waiting', current: id }, id, {
    status: 'waiting',
    waitingSince: now,
  }),
  action: { kind: 'wait', stage: id },
})

const finish = (task: Task, now: number): Step => ({
  task: { ...task, status: 'done', endedAt: now },
  action: { kind: 'done' },
})

const fail = (task: Task, now: number, reason: string): Step => ({
  task: { ...task, status: 'failed', endedAt: now },
  action: { kind: 'failed', reason },
})

/** 某阶段之后该做什么：跳过不适用的阶段，遇到 before 闸门就等待。 */
const advanceFrom = (task: Task, from: StageId, now: number, config: MachineConfig): Step => {
  const index = STAGES.findIndex(s => s.id === from)
  let current = task
  for (const def of STAGES.slice(index + 1)) {
    const skip =
      (def.id === 'test' && !config.hasTest) || (def.id === 'deploy' && !config.hasDeploy)
    if (skip) {
      current = setStage(current, def.id, {
        status: 'skipped',
        note: def.id === 'test' ? '未配置测试命令' : '未配置部署命令',
      })
      continue
    }
    return def.gate === 'before' ? wait(current, def.id, now) : begin(current, def.id, now)
  }
  return finish(current, now)
}

/** 回到开发阶段返工，带上反馈。 */
const reworkDev = (task: Task, now: number, config: MachineConfig, feedback: string): Step => {
  if (task.rework >= config.maxRework) {
    // 保留反馈：人工 retry 时会带着它回到开发。
    return fail({ ...task, feedback }, now, `已返工 ${task.rework} 次仍未通过，需要人工介入`)
  }
  let reset: Task = { ...task, rework: task.rework + 1, feedback }
  for (const id of ['test', 'review', 'merge'] as const) {
    if (reset.stages[id].status !== 'skipped') reset = setStage(reset, id, { status: 'pending' })
  }
  return begin(reset, 'dev', now)
}

/** 新任务进入流水线。 */
export const startTask = (task: Task, now: number): Step => begin(task, 'spec', now)

/** 状态机：给定事件返回新任务与下一步动作。纯函数。 */
export const reduce = (task: Task, event: Event, now: number, config: MachineConfig): Step => {
  if (isTerminal(task) && event.kind !== 'retry') {
    return { task, action: { kind: 'none', reason: '任务已结束' } }
  }
  const id = task.current
  const run = task.stages[id]
  const stamped = { ...task, updatedAt: now }

  switch (event.kind) {
    case 'abort':
      return {
        task: setStage({ ...stamped, status: 'aborted', endedAt: now }, id, {
          status: run.status === 'running' || run.status === 'waiting' ? 'failed' : run.status,
          note: '已中止',
          agentId: undefined,
        }),
        action: { kind: 'none', reason: '已中止' },
      }

    case 'progress': {
      if (event.stage !== id || run.status !== 'running') return { task, action: { kind: 'none' } }
      return {
        task: setStage(stamped, id, {
          durationMs: run.durationMs + event.durationMs,
          tokens: addTokens(run.tokens, event.tokens),
          model: event.model ?? run.model,
        }),
        action: { kind: 'none' },
      }
    }

    case 'finished': {
      if (event.stage !== id || run.status !== 'running') {
        return { task, action: { kind: 'none', reason: '不是当前运行中的阶段' } }
      }
      const done = setStage(stamped, id, {
        status: event.ok ? 'passed' : 'failed',
        endedAt: now,
        durationMs: run.durationMs + event.durationMs,
        tokens: addTokens(run.tokens, event.tokens),
        model: event.model ?? run.model,
        note: event.note,
        agentId: undefined,
      })
      if (id === 'test' || id === 'review') {
        const firstPass = run.attempts === 1 ? { ...done.firstPass, [id]: event.ok } : done.firstPass
        const withPass = { ...done, firstPass }
        if (!event.ok) {
          const label = id === 'test' ? '单元测试未通过' : 'Code Review 未通过'
          return reworkDev(withPass, now, config, `${label}：\n${event.note ?? ''}`)
        }
        return advanceFrom({ ...withPass, feedback: undefined }, id, now, config)
      }
      if (!event.ok) return fail(done, now, `${stageDef(id).label} 失败：${event.note ?? ''}`)
      if (stageDef(id).gate === 'after') return wait(done, id, now)
      return advanceFrom(id === 'dev' ? done : { ...done, feedback: undefined }, id, now, config)
    }

    case 'approve': {
      if (task.status !== 'waiting') return { task, action: { kind: 'none', reason: '当前没有待批准的阶段' } }
      const waited = run.waitingSince === undefined ? 0 : now - run.waitingSince
      if (stageDef(id).gate === 'after') {
        const approved = setStage({ ...stamped, feedback: undefined }, id, {
          status: 'passed',
          waitingSince: undefined,
          waitMs: run.waitMs + waited,
        })
        return advanceFrom(approved, id, now, config)
      }
      return begin(stamped, id, now)
    }

    case 'reject': {
      if (task.status !== 'waiting') return { task, action: { kind: 'none', reason: '当前没有待批准的阶段' } }
      const waited = run.waitingSince === undefined ? 0 : now - run.waitingSince
      const closed = setStage(stamped, id, {
        waitingSince: undefined,
        waitMs: run.waitMs + waited,
        note: `驳回：${event.reason}`,
      })
      if (id === 'spec') return begin({ ...closed, feedback: `Spec 被驳回：${event.reason}` }, 'spec', now)
      if (id === 'merge') return reworkDev(closed, now, config, `合并前被驳回：${event.reason}`)
      // 驳回部署：跳过部署，任务以已合并结束。
      return finish(setStage(closed, id, { status: 'skipped' }), now)
    }

    case 'retry': {
      if (task.status === 'done') return { task, action: { kind: 'none', reason: '任务已完成' } }
      const revived = { ...stamped, status: 'running' as const, endedAt: undefined }
      // 返工用尽后的重试：重置计数，带着最后一轮反馈回到开发，而不是原地重跑测试 / 评审。
      if (task.status === 'failed' && (id === 'test' || id === 'review') && run.status === 'failed') {
        return reworkDev({ ...revived, rework: 0 }, now, config, task.feedback ?? '')
      }
      // 重试当前阶段：运行中的那次不再等待（例如会话重启后子 agent 已不在）。
      const reverted = setStage(revived, id, {
        status: 'pending',
        attempts: Math.max(0, run.attempts - (run.status === 'running' ? 1 : 0)),
      })
      if (stageDef(id).gate === 'before' && run.status !== 'running') return wait(reverted, id, now)
      return begin(reverted, id, now)
    }
  }
}
