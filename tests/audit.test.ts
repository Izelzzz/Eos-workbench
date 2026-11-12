import { expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { auditEntry, parseEntries } from '../hooks/core/audit'
import { STAGES, emptyRun, reduce, startTask } from '../hooks/core/pipeline'
import type { Event, MachineConfig } from '../hooks/core/pipeline'

const FULL: MachineConfig = { maxRework: 2, hasTest: true, hasDeploy: true }

const draft = (): Task => ({
  id: 't1',
  title: '示例',
  request: '示例需求',
  createdAt: 0,
  updatedAt: 0,
  status: 'running',
  current: 'spec',
  stages: Object.fromEntries(STAGES.map(s => [s.id, emptyRun(s.id)])) as Task['stages'],
  rework: 0,
  firstPass: {},
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'eos/t1', worktree: '/w' },
  dir: '/d',
})

const entryOf = (before: Task, event: Event, actor: 'command' | 'panel' | 'agent' = 'command') => {
  const { task: after, action } = reduce(before, event, 5000, FULL)
  return auditEntry({ before, after, event, action, actor, ts: 5000 })
}

const specDone = reduce(startTask(draft(), 0).task, { kind: 'finished', stage: 'spec', seq: 1, ok: true, durationMs: 10 }, 1000, FULL).task

test('批准：记下前后状态、动作与发起者', () => {
  const entry = entryOf(specDone, { kind: 'approve' }, 'panel')
  expect(entry).toEqual({
    ts: 5000,
    taskId: 't1',
    actor: 'panel',
    event: { kind: 'approve' },
    stage: 'spec',
    before: { status: 'waiting', current: 'spec', stageStatus: 'waiting', seq: 1 },
    after: { status: 'running', current: 'dev', stageStatus: 'passed', seq: 1 },
    action: { kind: 'run', stage: 'dev' },
    accepted: true,
  })
})

test('被拒绝的驳回和过期的结果：accepted 为 false，理由留在事件里', () => {
  const refused = entryOf(specDone, { kind: 'reject', reason: '   ' })
  expect(refused.accepted).toBe(false)
  expect(refused.event).toEqual({ kind: 'reject', reason: '   ' })
  expect(refused.action).toEqual({ kind: 'none', reason: '驳回需要填写理由' })

  const stale = entryOf(specDone, { kind: 'finished', stage: 'spec', seq: 0, ok: true, durationMs: 1 }, 'agent')
  expect(stale.accepted).toBe(false)
  expect(stale.stage).toBe('spec')
})

test('阶段取事件里的阶段：迟到的结果记在它自己的阶段上', () => {
  const dev = reduce(specDone, { kind: 'approve' }, 2000, FULL).task
  const entry = entryOf(dev, { kind: 'progress', stage: 'spec', seq: 1, durationMs: 1 }, 'agent')
  expect(entry.stage).toBe('spec')
  expect(entry.before?.stageStatus).toBe('passed')
})

test('任务创建：没有 before，accepted 为 true；整条可以写成一行 JSON 再读回', () => {
  const task = startTask(draft(), 0).task
  const entry = auditEntry({ after: task, event: { kind: 'create', title: '示例', request: '示例需求' }, actor: 'command', ts: 0 })
  expect(entry.before).toBe(undefined)
  expect(entry.accepted).toBe(true)
  expect(entry.after).toEqual({ status: 'running', current: 'spec', stageStatus: 'running', seq: 1 })
  const tokens = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  const progress = entryOf(task, { kind: 'progress', stage: 'spec', seq: 1, durationMs: 3, tokens }, 'agent')
  const text = [entry, progress].map(e => JSON.stringify(e)).join('\n') + '\n{"broken'
  expect(parseEntries(text)).toEqual([entry, progress])
})
