// 流水线的纯逻辑：阶段定义与状态机。不依赖引擎（$），可单独测试。
import type { StageId, StageRun, Task, Tokens } from '../../types'

export type StageDef = {
  id: StageId
  label: string
  /** after：本阶段完成后等人工批准；before：开始前等人工批准。 */
  gate?: 'before' | 'after'
  /** 可以手动跳过（例如已在流水线之外完成）。Spec 和开发的产物后续阶段要读，不能跳过。 */
  skippable?: true
}

export const STAGES: readonly StageDef[] = [
  { id: 'spec', label: '需求 Spec', gate: 'after' },
  { id: 'dev', label: '代码开发' },
  { id: 'test', label: '单元测试', skippable: true },
  { id: 'review', label: 'Code Review', skippable: true },
  { id: 'merge', label: '合并', gate: 'before', skippable: true },
  { id: 'deploy', label: '发布部署', gate: 'before', skippable: true },
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
  | { kind: 'skip'; reason: string }
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

/** 失败或驳回之后的去向：带着反馈回到某个阶段重跑，或跳过本阶段继续往后。 */
export type Route =
  | { kind: 'back'; to: StageId; rework: boolean; feedback: (detail: string) => string }
  | { kind: 'skip' }

/**
 * 每个阶段失败（fail）或在闸门被驳回（reject）之后去哪。
 * 没有 fail 的阶段失败即任务失败，等人工重试；没有 reject 的阶段不能驳回。
 * rework 计入返工次数，受 maxRework 限制。
 */
export const TRANSITIONS: Partial<Record<StageId, { fail?: Route; reject?: Route }>> = {
  spec: { reject: { kind: 'back', to: 'spec', rework: false, feedback: reason => `Spec 被驳回：${reason}` } },
  test: { fail: { kind: 'back', to: 'dev', rework: true, feedback: note => `单元测试未通过：\n${note}` } },
  review: { fail: { kind: 'back', to: 'dev', rework: true, feedback: note => `Code Review 未通过：\n${note}` } },
  // 不算返工：评审者要先核实人工指出的问题，确认后才打回开发。
  merge: { reject: { kind: 'back', to: 'review', rework: false, feedback: reason => `合并前被驳回：${reason}` } },
  deploy: { reject: { kind: 'skip' } },
}

/** 回到 to 阶段重跑：它之后的阶段重新排队（未配置而跳过的保持跳过）。 */
const goBack = (task: Task, to: StageId, feedback: string, rework: boolean, now: number, config: MachineConfig): Step => {
  if (rework && task.rework >= config.maxRework) {
    // 保留反馈：人工 retry 时会带着它回去。
    return fail({ ...task, feedback }, now, `已返工 ${task.rework} 次仍未通过，需要人工介入`)
  }
  let reset: Task = { ...task, rework: task.rework + (rework ? 1 : 0), feedback }
  for (const def of STAGES.slice(STAGES.findIndex(s => s.id === to) + 1)) {
    if (reset.stages[def.id].status !== 'skipped') reset = setStage(reset, def.id, { status: 'pending' })
  }
  return begin(reset, to, now)
}

const follow = (task: Task, from: StageId, route: Route, detail: string, now: number, config: MachineConfig): Step =>
  route.kind === 'skip'
    ? advanceFrom(setStage(task, from, { status: 'skipped' }), from, now, config)
    : goBack(task, route.to, route.feedback(detail), route.rework, now, config)

/** 新任务进入流水线。 */
export const startTask = (task: Task, now: number): Step => begin(task, 'spec', now)

/** 状态机：给定事件返回新任务与下一步动作。纯函数。 */
export const reduce = (task: Task, event: Event, now: number, config: MachineConfig): Step => {
  if (isTerminal(task) && event.kind !== 'retry' && !(event.kind === 'skip' && task.status === 'failed')) {
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
      const settled =
        (id === 'test' || id === 'review') && run.attempts === 1
          ? { ...done, firstPass: { ...done.firstPass, [id]: event.ok } }
          : done
      if (!event.ok) {
        const route = TRANSITIONS[id]?.fail
        if (route !== undefined) return follow(settled, id, route, event.note ?? '', now, config)
        return fail(settled, now, `${stageDef(id).label} 失败：${event.note ?? ''}`)
      }
      if (stageDef(id).gate === 'after') return wait(settled, id, now)
      return advanceFrom({ ...settled, feedback: undefined }, id, now, config)
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
      const reason = event.reason.trim()
      if (reason === '') return { task, action: { kind: 'none', reason: '驳回需要填写理由' } }
      const route = TRANSITIONS[id]?.reject
      if (route === undefined) return { task, action: { kind: 'none', reason: `${stageDef(id).label}不能驳回` } }
      const waited = run.waitingSince === undefined ? 0 : now - run.waitingSince
      const closed = setStage(stamped, id, {
        waitingSince: undefined,
        waitMs: run.waitMs + waited,
        note: `驳回：${reason}`,
      })
      return follow(closed, id, route, reason, now, config)
    }

    case 'retry': {
      if (task.status === 'done') return { task, action: { kind: 'none', reason: '任务已完成' } }
      const revived = { ...stamped, status: 'running' as const, endedAt: undefined }
      // 返工用尽后的重试：重置计数，带着最后一轮反馈回去，而不是原地重跑测试 / 评审。
      const route = TRANSITIONS[id]?.fail
      if (task.status === 'failed' && run.status === 'failed' && route?.kind === 'back' && route.rework) {
        return goBack({ ...revived, rework: 0 }, route.to, task.feedback ?? '', true, now, config)
      }
      // 重试当前阶段：运行中的那次不再等待（例如会话重启后子 agent 已不在）。
      const reverted = setStage(revived, id, {
        status: 'pending',
        attempts: Math.max(0, run.attempts - (run.status === 'running' ? 1 : 0)),
      })
      if (stageDef(id).gate === 'before' && run.status !== 'running') return wait(reverted, id, now)
      return begin(reverted, id, now)
    }

    case 'skip': {
      // 运行中的阶段不能跳过：它的子 agent 或命令还会回来写结果。
      if (task.status !== 'waiting' && task.status !== 'failed') {
        return { task, action: { kind: 'none', reason: '只能跳过等待中或失败的阶段' } }
      }
      if (!stageDef(id).skippable) {
        return { task, action: { kind: 'none', reason: `${stageDef(id).label}不能跳过，后续阶段依赖它的产物` } }
      }
      const waited = run.waitingSince === undefined ? 0 : now - run.waitingSince
      const skipped = setStage({ ...stamped, status: 'running', endedAt: undefined, feedback: undefined }, id, {
        status: 'skipped',
        note: `跳过：${event.reason}`,
        waitingSince: undefined,
        waitMs: run.waitMs + waited,
        agentId: undefined,
      })
      return advanceFrom(skipped, id, now, config)
    }
  }
}

/**
 * 这次事件之后需要停掉的子 agent：中止或重试时，运行中那次的子 agent 不再属于阶段，
 * 不停掉它会在后台继续干活。finished / progress 不停：agent 已经结束或仍是阶段的 agent。
 */
export const agentToStop = (before: Task, after: Task, event: Event): string | undefined => {
  if (event.kind !== 'abort' && event.kind !== 'retry') return undefined
  const run = before.stages[before.current]
  if (run.status !== 'running' || run.agentId === undefined) return undefined
  return after.stages[before.current].agentId === run.agentId ? undefined : run.agentId
}
