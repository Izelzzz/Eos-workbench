import { expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { auditEntry } from '../hooks/core/audit'
import type { Actor, AuditEntry, AuditEvent } from '../hooks/core/audit'
import { STAGES, annotateRun, emptyRun, reduce, startTask } from '../hooks/core/pipeline'
import type { Event, MachineConfig } from '../hooks/core/pipeline'
import { formatTimeline } from '../hooks/core/timeline'

const FULL: MachineConfig = { maxRework: 2, hasTest: true, hasDeploy: false }
// 2026-11-11 09:00:00 UTC：东八区 17:00:00。
const T0 = Date.UTC(2026, 10, 11, 9, 0, 0)

const draft = (): Task => ({
  id: 't1',
  title: '给登录页加验证码',
  request: '给登录页加验证码',
  createdAt: T0,
  updatedAt: T0,
  status: 'running',
  current: 'spec',
  stages: Object.fromEntries(STAGES.map(s => [s.id, emptyRun(s.id)])) as Task['stages'],
  rework: 0,
  firstPass: {},
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'eos/t1', worktree: '/w' },
  dir: '/d',
})

type Step = [number, Actor, Event | ((t: Task) => Event) | { notice: (t: Task) => [Task, AuditEvent] }]

/** 按时间喂事件，同时像引擎一样写审计记录。 */
const run = (steps: Step[]) => {
  const started = startTask(draft(), T0)
  let task = started.task
  const entries: AuditEntry[] = [
    auditEntry({ after: task, event: { kind: 'create', title: task.title, request: task.request }, action: started.action, actor: 'command', ts: T0 }),
  ]
  for (const [sec, actor, make] of steps) {
    const ts = T0 + sec * 1000
    if (typeof make === 'object' && 'notice' in make) {
      const [after, event] = make.notice(task)
      entries.push(auditEntry({ before: task, after, event, actor, ts }))
      task = after
      continue
    }
    const event = typeof make === 'function' ? make(task) : make
    const { task: after, action } = reduce(task, event, ts, FULL)
    entries.push(auditEntry({ before: task, after, event, action, actor, ts }))
    task = after
  }
  return { task, entries }
}

const k = 1000
const tokens = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
const done = (stage: Task['current'], ok: boolean, ms: number, t = tokens(0, 0), note?: string) => (task: Task): Event => ({
  kind: 'finished',
  stage,
  seq: task.stages[stage].seq,
  ok,
  note,
  durationMs: ms,
  tokens: t,
})
const agent = (stage: 'spec' | 'dev' | 'review', id: string) => ({
  notice: (task: Task): [Task, AuditEvent] => {
    const ref = { stage, seq: task.stages[stage].seq }
    const used = { agentId: id, model: 'opus', effort: 'high', skills: ['pstack:poteto-mode'] }
    return [annotateRun(task, ref, used), { kind: 'agent', ...ref, ...used, readFirst: ['/p/SKILL.md'] }]
  },
})

const story: Step[] = [
  [1, 'system', agent('spec', 'a1')],
  [60, 'agent', done('spec', true, 59 * k, tokens(12 * k, 1200))],
  [90, 'panel', { kind: 'approve' }],
  [91, 'system', agent('dev', 'a2')],
  [150, 'agent', t => ({ kind: 'progress', stage: 'dev', seq: t.stages.dev.seq, durationMs: 30 * k, tokens: tokens(40 * k, 1000) })],
  [280, 'agent', done('dev', true, 160 * k, tokens(80 * k, 2000))],
  [300, 'command', { kind: 'retry' }],
  [301, 'process', t => ({ kind: 'progress', stage: 'test', seq: t.stages.test.seq - 1, durationMs: 20 * k })],
  [330, 'process', done('test', false, 29 * k, undefined, 'exit 1\n1 failed')],
  [331, 'system', agent('dev', 'a3')],
  [500, 'agent', done('dev', true, 169 * k, tokens(60 * k, 1500))],
  [530, 'process', done('test', true, 30 * k)],
  [531, 'system', agent('review', 'a4')],
  [600, 'agent', done('review', true, 69 * k, tokens(30 * k, 800))],
  [700, 'command', { kind: 'reject', reason: '' }],
  [710, 'command', { kind: 'reject', reason: '命名不对' }],
  [711, 'system', agent('review', 'a5')],
  [760, 'agent', done('review', true, 49 * k, tokens(20 * k, 500))],
  [900, 'panel', { kind: 'approve' }],
  [910, 'process', done('merge', true, 10 * k)],
]

test('时间线：每条事件一行，带本地时间、发起者、中文描述和下一步；最后是各阶段汇总', () => {
  const { task, entries } = run(story)
  const text = formatTimeline({ task, entries, now: T0 + 1000 * k, offsetMinutes: () => 480 })
  expect(text).toBe(
    [
      '「给登录页加验证码」 t1 · 已完成',
      '',
      '2026-11-11',
      '  17:00:00  [命令] 创建任务：给登录页加验证码 → 开始 需求 Spec 第 1 次',
      '  17:00:01  [系统] 需求 Spec 第 1 次：启动子 agent（opus · effort high · skill pstack:poteto-mode）；提示词里要求先读 1 个 SKILL.md',
      '  17:01:00  [子 agent] 需求 Spec 第 1 次运行结束：通过 · 59s · 12.0k 入 / 1.2k 出 → 等待批准 需求 Spec',
      '  17:01:30  [面板] 人工批准 需求 Spec → 开始 代码开发 第 1 次',
      '  17:01:31  [系统] 代码开发 第 1 次：启动子 agent（opus · effort high · skill pstack:poteto-mode）；提示词里要求先读 1 个 SKILL.md',
      '  17:02:30  [子 agent] 代码开发 第 1 次运行中：+30s · 40.0k 入 / 1.0k 出',
      '  17:04:40  [子 agent] 代码开发 第 1 次运行结束：通过 · 3m10s · 120.0k 入 / 3.0k 出 → 开始 单元测试 第 1 次',
      '  17:05:00  [命令] 放弃 单元测试 第 1 次（重试） → 开始 单元测试 第 2 次',
      '  17:05:01  [进程] 单元测试 第 1 次（已放弃）迟到的用量：20s，只记到这次运行上',
      '  17:05:30  [进程] 单元测试 第 2 次运行结束：失败 · 29s（exit 1） → 开始 代码开发 第 2 次',
      '  17:05:31  [系统] 代码开发 第 2 次：启动子 agent（opus · effort high · skill pstack:poteto-mode）；提示词里要求先读 1 个 SKILL.md',
      '  17:08:20  [子 agent] 代码开发 第 2 次运行结束：通过 · 2m49s · 60.0k 入 / 1.5k 出 → 开始 单元测试 第 3 次',
      '  17:08:50  [进程] 单元测试 第 3 次运行结束：通过 · 30s → 开始 Code Review 第 1 次',
      '  17:08:51  [系统] Code Review 第 1 次：启动子 agent（opus · effort high · skill pstack:poteto-mode）；提示词里要求先读 1 个 SKILL.md',
      '  17:10:00  [子 agent] Code Review 第 1 次运行结束：通过 · 1m09s · 30.0k 入 / 800 出 → 等待批准 合并',
      '  17:11:40  [命令] 驳回未生效：驳回需要填写理由',
      '  17:11:50  [命令] 驳回 合并：命名不对 → 开始 Code Review 第 2 次',
      '  17:11:51  [系统] Code Review 第 2 次：启动子 agent（opus · effort high · skill pstack:poteto-mode）；提示词里要求先读 1 个 SKILL.md',
      '  17:12:40  [子 agent] Code Review 第 2 次运行结束：通过 · 49s · 20.0k 入 / 500 出 → 等待批准 合并',
      '  17:15:00  [面板] 人工批准 合并 → 开始 合并 第 1 次',
      '  17:15:10  [进程] 合并 第 1 次运行结束：通过 · 10s → 流水线完成',
      '',
      '汇总',
      '  需求 Spec  1 次 · 59s · 12.0k 入 / 1.2k 出 · 等待 30s',
      '  代码开发  2 次 · 5m59s · 180.0k 入 / 4.5k 出',
      '  单元测试  2 次，放弃 1 次（20s） · 59s',
      '  Code Review  2 次 · 1m58s · 50.0k 入 / 1.3k 出',
      '  合并  1 次 · 10s · 等待 4m10s',
      '  发布部署  已跳过：未配置部署命令',
      '  合计  执行 10m05s · 等待 4m40s · Token 242.0k 入 / 7.0k 出 · 返工 1',
      '  被放弃的运行另外花了 20s（不计入上面的合计）',
    ].join('\n'),
  )
})

test('时间线：跨天时换日期；旧任务没有事件和运行明细时注明', () => {
  const { task, entries } = run([[86_400, 'command', { kind: 'abort' }]])
  const text = formatTimeline({ task, entries, now: T0, offsetMinutes: () => 480 })
  expect(text).toContain('\n2026-11-12\n  17:00:00  [命令] 中止任务，放弃 需求 Spec 第 1 次')

  const legacy: Task = { ...draft(), status: 'done', stages: { ...draft().stages, spec: { ...emptyRun('spec'), status: 'passed', attempts: 2, durationMs: 5000 } } }
  const old = formatTimeline({ task: legacy, entries: [], now: T0, offsetMinutes: () => 0 })
  expect(old).toContain('（没有事件记录：这个任务创建于审计记录之前）')
  expect(old).toContain('  需求 Spec  2 次（早于运行明细，只有累计值） · 5s')
})
