import assert from 'node:assert/strict'
import { newTask, reduce } from '../src/engine/machine.ts'
import type { Event, Task } from '../src/engine/types.ts'
import { zeroUsage } from '../src/engine/types.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import type { Workflow } from '../src/workflow/types.ts'

export const workflow = (opts: { maxRounds: number; escalate: boolean }): Workflow => {
  const r = parseWorkflow(`
name: t
roles:
  planner: { prompt: 你负责规划 }
  dev: { prompt: 你负责开发, write: worktree }
  rev: { prompt: 你负责评审 }
nodes:
  - { id: plan, kind: agent, role: planner, task: 写方案 }
  - { id: build, kind: agent, role: dev, task: 实现, inputs: [plan] }
  - { id: review, kind: dialog, role: rev, with: build, maxRounds: ${opts.maxRounds}, task: 评审, inputs: [plan]${opts.escalate ? ', escalate: plan' : ''} }
`)
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors))
  return r.workflow
}

export const PASS = '```json\n{"verdict":"pass","summary":"可以合并","issues":[]}\n```'
export const CHANGES = '```json\n{"verdict":"changes","summary":"缺少测试","issues":[{"severity":"major","message":"补测试"}]}\n```'
export const GARBAGE = '我觉得还行'
export const REVISE = '```json\n{"decision":"revise","plan":"新方案：先写测试"}\n```'
export const ASK = '```json\n{"decision":"ask_user","question":"要不要支持负数？"}\n```'

/** 测试用的驱动：每个事件都必须被接受，时间每步加一。 */
export class Driver {
  task: Task
  at = 0
  constructor(wf: Workflow) {
    this.task = newTask({ id: 't1', request: '加一个求和函数', workflow: wf }, 0)
  }
  send(event: Event): Task {
    const step = reduce(this.task, event, ++this.at)
    assert.ok(step.accepted, `event ${JSON.stringify(event)} rejected: ${step.reason}`)
    this.task = step.task
    return this.task
  }
  /** 回复当前 pending 调用；会话 id 用 "s-<会话所属节点>"，模拟执行器为每个会话固定一个 id。 */
  reply(text: string): Task {
    const call = this.task.pending
    assert.ok(call, 'no pending call')
    return this.send({ kind: 'replied', call: call.id, sessionId: `s-${call.session}`, text, usage: { ...zeroUsage(), input: 10, output: 2 }, ms: 5 })
  }
  get pending() {
    assert.ok(this.task.pending, 'no pending call')
    return this.task.pending
  }
  purposes(): string[] {
    return this.task.log.flatMap(e => (e.type === 'call' ? [`${e.purpose}@${e.node}`] : []))
  }
}
