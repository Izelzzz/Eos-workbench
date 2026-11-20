import assert from 'node:assert/strict'
import { newTask, reduce } from '../src/engine/machine.ts'
import type { Call, CheckResult, CheckRun, ConventionDoc, Event, Task } from '../src/engine/types.ts'
import { isCheck, zeroUsage } from '../src/engine/types.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import type { Workflow } from '../src/workflow/types.ts'

/**
 * checks：none 没有检查；review 开发节点有交付物（最多补齐 maxFixes 次），评审对话每轮先跑测试；
 * only 开发节点有交付物，对话只有测试、没有评审方。
 */
export const workflow = (opts: { maxRounds: number; escalate: boolean; checks?: 'none' | 'review' | 'only'; maxFixes?: number }): Workflow => {
  const checks = opts.checks ?? 'none'
  const build = checks === 'none' ? '' : `, maxFixes: ${opts.maxFixes ?? 1}, deliverables: [{ path: NOTES.md, sections: [改动] }]`
  const review = checks === 'none' ? ', role: rev' : checks === 'review' ? ', role: rev, checks: [{ run: [npm, test] }]' : ', checks: [{ run: [npm, test] }]'
  const r = parseWorkflow(`
name: t
roles:
  planner: { prompt: 你负责规划 }
  dev: { prompt: 你负责开发, write: worktree }
  rev: { prompt: 你负责评审 }
nodes:
  - { id: plan, kind: agent, role: planner, task: 写方案 }
  - { id: build, kind: agent, role: dev, task: 实现, inputs: [plan]${build} }
  - { id: review, kind: dialog${review}, with: build, maxRounds: ${opts.maxRounds}, task: 评审, inputs: [plan]${opts.escalate ? ', escalate: plan' : ''} }
`)
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors))
  return r.workflow
}

export const PASS = '```json\n{"verdict":"pass","summary":"可以合并","issues":[]}\n```'
export const CHANGES = '```json\n{"verdict":"changes","summary":"缺少测试","issues":[{"severity":"major","message":"补测试"}]}\n```'
export const GARBAGE = '我觉得还行'
export const REVISE = '```json\n{"decision":"revise","plan":"新方案：先写测试"}\n```'
export const ASK = '```json\n{"decision":"ask_user","question":"要不要支持负数？"}\n```'

/** 检查结果：passed 为 false 时每条都不通过。 */
export const results = (run: CheckRun, passed: boolean, detail = passed ? '' : '1 个测试失败'): CheckResult[] =>
  run.checks.map(check => ({ check, passed, detail }))

/** 测试用的驱动：每个事件都必须被接受，时间每步加一。 */
export class Driver {
  task: Task
  at = 0
  constructor(wf: Workflow, docs: ConventionDoc[] = []) {
    this.task = newTask({ id: 't1', request: '加一个求和函数', workflow: wf, docs }, 0)
  }
  send(event: Event): Task {
    const step = reduce(this.task, event, ++this.at)
    assert.ok(step.accepted, `event ${JSON.stringify(event)} rejected: ${step.reason}`)
    this.task = step.task
    return this.task
  }
  /** 回复当前 pending 调用；会话 id 用 "s-<会话所属节点>"，模拟执行器为每个会话固定一个 id。 */
  reply(text: string): Task {
    const call = this.pending
    return this.send({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: { ...zeroUsage(), input: 10, output: 2 }, ms: 5 })
  }
  /** 当前待执行的 agent 调用（不是检查）。 */
  get pending(): Call {
    const p = this.task.pending
    assert.ok(p !== undefined && !isCheck(p), `no pending call (${p?.purpose})`)
    return p
  }
  get checking(): CheckRun {
    const p = this.task.pending
    assert.ok(p !== undefined && isCheck(p), `no pending check (${p?.purpose})`)
    return p
  }
  /** 回复当前的检查：全部通过或全部不通过。 */
  check(passed: boolean, detail?: string): Task {
    const run = this.checking
    return this.send({ kind: 'checked', call: run.id, results: results(run, passed, detail), ms: 3 })
  }
  purposes(): string[] {
    return this.task.log.flatMap(e => (e.type === 'call' ? [`${e.purpose}@${e.node}`] : []))
  }
}
