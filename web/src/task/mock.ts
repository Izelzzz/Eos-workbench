// 任务详情页原型的假数据。正式页面里这些来自平台接口

export type StageState = 'passed' | 'running' | 'waiting' | 'todo' | 'failed'
export type Span = { kind: '模型' | '工具' | '检查' | '提问' | '回答'; title: string; ms: number; tokens?: number; input?: string; thinking?: string; output?: string }
export type Call = { id: string; who: string; what: string; ms: number; tokens?: number; ok?: boolean; spans: Span[] }
export type Round = { n: number; result: '通过' | '没通过' | '进行中'; calls: Call[] }
export type Stage = { name: string; state: StageState; note: string; rounds: Round[] }

const sec = (s: number) => s * 1000
export const fmt = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒` : `${Math.round(ms / 1000)} 秒`)
export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`)

export const task = {
  id: 't-0142',
  title: '任务列表支持按状态筛选',
  need: '任务列表页增加按状态筛选，可以多选。筛选条件不用保存。',
  waiting: { kind: '验收', line: '评审已经通过，等你决定能不能交付。' },
  facts: [
    ['仓库', 'eos-workbench'],
    ['分支', 'eos/t-0142'],
    ['基线提交', '4a479ed'],
    ['工作流', 'standard 第 12 版'],
    ['开始', '今天 13:02'],
  ] as [string, string][],
  decisions: [{ when: '规格 · 13:05', q: '筛选要不要支持多选？', a: '要，多选' }],
  files: [
    ['web/src/App.tsx', '+48 −12'],
    ['web/src/api.ts', '+9 −2'],
    ['src/web/server.ts', '+21 −4'],
    ['src/store/store.ts', '+14 −0'],
    ['tests/web.tasks-filter.test.ts', '+64 −0'],
    ['docs/changes.md', '+18 −0'],
  ] as [string, string][],
  outputs: [
    ['docs/spec.md', '规格：背景、范围、4 条验收标准'],
    ['docs/changes.md', '改动说明'],
  ] as [string, string][],
}

const model = (title: string, s: number, tokens: number, output: string, thinking?: string): Span => ({ kind: '模型', title, ms: sec(s), tokens, input: '（上一步的结果和角色说明）', thinking, output })
const tool = (title: string, s: number, output: string): Span => ({ kind: '工具', title, ms: sec(s), input: title, output })

export const stages: Stage[] = [
  {
    name: '规格',
    state: 'passed',
    note: '1 轮 · 4 分钟',
    rounds: [
      {
        n: 1,
        result: '通过',
        calls: [
          {
            id: 's1',
            who: '规格 agent',
            what: '读了 3 个文件，问了 1 个问题，写了 docs/spec.md',
            ms: sec(212),
            tokens: 38200,
            spans: [
              tool('读 web/src/App.tsx', 1, '（462 行）'),
              model('想清楚范围', 14, 9100, '需要确认：筛选是否支持多选。', '列表页现在一次显示全部任务。筛选可以放在表头……'),
              { kind: '提问', title: '筛选要不要支持多选？', ms: sec(150), output: '选项：要，多选 / 单选就够' },
              { kind: '回答', title: '要，多选', ms: 0 },
              model('写规格', 31, 21400, '已写入 docs/spec.md：背景、范围、4 条验收标准。'),
            ],
          },
          { id: 's2', who: '检查', what: 'docs/spec.md 存在，包含「验收标准」一节', ms: sec(1), ok: true, spans: [{ kind: '检查', title: 'file-exists docs/spec.md', ms: 400, output: '通过' }] },
        ],
      },
    ],
  },
  {
    name: '开发',
    state: 'passed',
    note: '2 轮 · 21 分钟',
    rounds: [
      {
        n: 1,
        result: '没通过',
        calls: [
          { id: 'd1', who: '开发 agent', what: '改了 4 个文件', ms: sec(640), tokens: 182000, spans: [model('读规格，定方案', 22, 14800, '在 /api/tasks 加 status 参数，前端加多选。'), tool('改 src/web/server.ts', 2, '+17 −4'), tool('改 web/src/App.tsx', 3, '+41 −12'), tool('运行 npm run typecheck', 19, '通过')] },
          { id: 'd2', who: '检查', what: '改了 src/ 但没有改 tests/', ms: sec(1), ok: false, spans: [{ kind: '检查', title: 'changed-with-tests', ms: 600, output: '没通过：src/web/server.ts 有改动，tests/ 下没有对应的改动' }] },
        ],
      },
      {
        n: 2,
        result: '通过',
        calls: [
          { id: 'd3', who: '开发 agent', what: '补了测试，改了 2 个文件', ms: sec(410), tokens: 96000, spans: [model('补测试', 40, 31000, '新增 tests/web.tasks-filter.test.ts，覆盖 4 条验收标准。'), tool('写 tests/web.tasks-filter.test.ts', 2, '+64'), tool('运行 npm test', 48, '全部通过')] },
          { id: 'd4', who: '检查', what: '改动有对应的测试', ms: sec(1), ok: true, spans: [{ kind: '检查', title: 'changed-with-tests', ms: 500, output: '通过' }] },
        ],
      },
    ],
  },
  {
    name: '测试',
    state: 'passed',
    note: '2 轮 · 3 分钟',
    rounds: [
      {
        n: 1,
        result: '没通过',
        calls: [
          { id: 't1', who: '检查', what: 'npm test：1 个用例失败', ms: sec(48), ok: false, spans: [{ kind: '检查', title: 'npm test', ms: sec(48), output: '✗ tests/web.tasks-filter.test.ts › 状态为空时返回全部\n  expected 12, received 0' }] },
          { id: 't2', who: '开发 agent', what: '修了 src/web/server.ts', ms: sec(112), tokens: 18400, spans: [model('看失败的输出', 9, 6200, 'status 为空数组时被当成「一个都不要」。', '参数解析把空字符串拆成了 [""]……'), tool('改 src/web/server.ts', 2, '+4 −1'), tool('运行 npm test', 47, '全部通过')] },
        ],
      },
      { n: 2, result: '通过', calls: [{ id: 't3', who: '检查', what: 'npm test：全部通过', ms: sec(51), ok: true, spans: [{ kind: '检查', title: 'npm test', ms: sec(51), output: '214 个用例，全部通过' }] }] },
    ],
  },
  {
    name: '评审',
    state: 'passed',
    note: '1 轮 · 6 分钟',
    rounds: [
      {
        n: 1,
        result: '通过',
        calls: [{ id: 'r1', who: '评审 agent', what: '读了改动，没有要改的', ms: sec(338), tokens: 61000, spans: [tool('读 6 个文件的改动', 2, '+174 −18'), model('对照验收标准逐条看', 96, 44000, '4 条验收标准都有测试对应。通过。')] }],
      },
    ],
  },
  { name: '交付', state: 'waiting', note: '等你验收', rounds: [] },
]
