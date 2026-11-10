import { expect, test } from 'claude-code/testing'

import type { Task } from '../types'
import { STAGES, emptyRun } from '../hooks/core/pipeline'

const PANE = {
  plugin: 'devbench',
  component: 'Pane',
  requestId: 'devbench',
  props: {
    title: 'Devbench',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const task: Task = {
  id: '2611091200-ab12',
  title: '给登录页加验证码',
  request: '给登录页加验证码',
  createdAt: 0,
  updatedAt: 0,
  status: 'waiting',
  current: 'merge',
  stages: {
    ...(Object.fromEntries(STAGES.map(s => [s.id, emptyRun(s.id)])) as Task['stages']),
    spec: { ...emptyRun('spec'), status: 'passed', attempts: 1, durationMs: 60_000, artifacts: ['01-spec.md'] },
    dev: {
      ...emptyRun('dev'),
      status: 'passed',
      attempts: 2,
      durationMs: 300_000,
      tokens: { input: 1000, output: 2000, cacheRead: 0, cacheWrite: 0 },
    },
    test: { ...emptyRun('test'), status: 'passed', attempts: 2 },
    review: { ...emptyRun('review'), status: 'passed', attempts: 2 },
    merge: { ...emptyRun('merge'), status: 'waiting', waitingSince: 0 },
  },
  rework: 1,
  firstPass: { test: true, review: false },
  git: { baseBranch: 'main', baseSha: 'abc', branch: 'devbench/2611091200-ab12', worktree: '/w' },
  dir: '/repo/.devbench/tasks/2611091200-ab12',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seed = (on: any, tasks: Task[]) => {
  on('clock.now', () => ({ value: 600_000 }))
  on('state.get', (_$: unknown, e: { key: string }) =>
    e.key === 'tasks'
      ? { value: { value: { shape: 'tasks-1', value: tasks }, version: 1 } }
      : { value: { value: null, version: 0 } },
  )
}

test('面板显示阶段、指标与批准按钮', async ($, on) => {
  seed(on, [task])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /给登录页加验证码/ }))?.text).toBe('给登录页加验证码')
    expect(await ui.find({ type: 'Text', text: /代码开发.*第 2 次/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /一次通过率 50%/ })).toBeDefined()
    expect(await ui.find({ key: 'approve' })).toBeDefined()
    expect(await ui.find({ key: 'skip' })).toBeDefined()
    await ui.unmount()
  }
})

test('没有任务时给出提示', async ($, on) => {
  seed(on, [])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /还没有任务/ }))?.text).toBe('还没有任务。')
  await ui.unmount()
})
