// 原型用的假数据。正式页面里这些来自平台接口。

export type Stage = '规格' | '开发' | '测试' | '评审' | '交付'
export const STAGES: Stage[] = ['规格', '开发', '测试', '评审', '交付']

export type Task = {
  id: string
  title: string
  repo: string
  /** 已经走完的阶段数（0～5） */
  done: number
  status: string
  waiting?: boolean
}

export type Option = { label: string; note: string; recommended?: boolean }
export type Step = { tab: string; question: string; options: Option[] }

export type PendingItem =
  | { kind: 'question'; id: string; taskId: string; title: string; meta: string; background: string; steps: Step[]; resolved: string }
  | { kind: 'accept'; id: string; taskId: string; title: string; meta: string; facts: [string, string][]; note: string; resolved: string }
  | { kind: 'proposal'; id: string; taskId?: undefined; title: string; meta: string; body: string; effect: string; resolved: string }

export const KIND_LABEL: Record<PendingItem['kind'], string> = { question: '提问', accept: '验收', proposal: '提案' }

export const initialTasks: Task[] = [
  { id: 't-0147', title: '导出任务列表为 CSV', repo: 'eos-workbench', done: 0, status: '规格 · 等你回答', waiting: true },
  { id: 't-0142', title: '任务列表支持按状态筛选', repo: 'eos-workbench', done: 4, status: '评审通过 · 等你验收', waiting: true },
  { id: 't-0145', title: '统计页增加按仓库筛选', repo: 'eos-workbench', done: 2, status: '测试 · 第 2 轮 · 18 分钟' },
  { id: 't-0146', title: '修复凭据页在窄屏下溢出', repo: 'eos-workbench', done: 1, status: '开发 · 第 1 轮 · 6 分钟' },
  { id: 't-0144', title: 'doctor 的输出支持 JSON', repo: 'eos-workbench', done: 3, status: '评审 · 第 1 轮 · 2 分钟' },
  { id: 't-0143', title: '改进页的提案按工作流分组', repo: 'eos-workbench', done: 1, status: '开发 · 第 2 轮 · 11 分钟' },
  { id: 't-0148', title: '凭据页支持批量删除', repo: 'eos-workbench', done: 0, status: '规格 · 3 分钟' },
  { id: 't-0141', title: '任务日志下载改成流式', repo: 'eos-workbench', done: 2, status: '测试 · 第 1 轮 · 1 分钟' },
  { id: 't-0140', title: 'README 补充命令行示例', repo: 'eos-docs', done: 3, status: '评审 · 第 2 轮 · 4 分钟' },
  { id: 't-0139', title: '升级 vite 到最新的小版本', repo: 'eos-workbench', done: 4, status: '交付 · 正在推送' },
  { id: 't-0138', title: '统计页的图表支持暗色', repo: 'eos-workbench', done: 1, status: '开发 · 第 1 轮 · 9 分钟' },
  { id: 't-0137', title: '对话页支持粘贴图片', repo: 'eos-workbench', done: 0, status: '规格 · 1 分钟' },
]

export const initialPending: PendingItem[] = [
  {
    kind: 'question',
    id: 'p1',
    taskId: 't-0147',
    title: '导出任务列表为 CSV',
    meta: 'eos-workbench · 规格阶段 · 12 分钟前',
    background: '规格 agent 在写验收标准。你的需求里有两处没有说：导出的范围，和文件的编码。',
    steps: [
      {
        tab: '范围',
        question: '导出时要不要包含已中止的任务？',
        options: [
          { label: '包含，并加一列「状态」', note: '和列表页看到的一致；要排除时在表格里按状态筛掉。', recommended: true },
          { label: '不包含', note: '导出的行数会和列表页不一样。' },
          { label: '导出时让人选', note: '多一个选项，范围变大。' },
        ],
      },
      {
        tab: '编码',
        question: '文件用什么编码？',
        options: [
          { label: '带 BOM 的 UTF-8', note: 'Excel 直接打开，中文不乱码。', recommended: true },
          { label: 'UTF-8', note: '给脚本读更干净；Excel 打开中文可能乱码。' },
        ],
      },
    ],
    resolved: '规格 · 继续中',
  },
  {
    kind: 'accept',
    id: 'p2',
    taskId: 't-0142',
    title: '任务列表支持按状态筛选',
    meta: 'eos-workbench · 评审通过 · 1 小时前',
    facts: [
      ['改动', '6 个文件，+142 −18'],
      ['测试', '通过，第 2 轮'],
      ['评审', '通过，第 1 轮'],
    ],
    note: '筛选条件没有保存到地址里，刷新后会丢。规格没有要求，评审也没有提。',
    resolved: '交付 · 正在开 PR',
  },
  {
    kind: 'proposal',
    id: 'p3',
    title: '开发阶段增加「改动要有对应测试」',
    meta: 'standard 工作流 · 昨天',
    body: '最近 4 个任务在评审时才发现没有补测试，各多返工了一轮。',
    effect: '批准后成为 standard 的第 13 版，对新建的任务生效。',
    resolved: '',
  },
]

export type ChatMessage = { from: 'me' | 'agent'; text: string; draft?: { title: string; repo: string; workflow: string; need: string } }
export type Conversation = { id: string; title: string; when: string; messages: ChatMessage[] }

export const conversations: Conversation[] = [
  {
    id: 'c2',
    title: '统计页导出周报',
    when: '2 天前',
    messages: [
      { from: 'me', text: '统计页加一个导出周报的按钮，导出成 Markdown，包含本周完成的任务和每个阶段的平均耗时。' },
      {
        from: 'agent',
        text: '我按这个需求准备了一个任务。',
        draft: { title: '统计页导出周报', repo: 'eos-workbench', workflow: 'standard', need: '统计页增加「导出周报」按钮，导出 Markdown：本周完成的任务，和每个阶段的平均耗时。' },
      },
    ],
  },
  {
    id: 'c3',
    title: '给开发阶段加一条检查',
    when: '昨天',
    messages: [
      { from: 'me', text: '最近好几个任务评审时才发现没写测试，能不能在开发阶段就拦住？' },
      { from: 'agent', text: '可以。我看了最近 4 个被评审打回的任务，都是开发阶段没有补测试。我提了一条改进提案，在「等你处理」里。' },
    ],
  },
  { id: 'c4', title: '上周为什么评审不通过的多', when: '5 天前', messages: [{ from: 'me', text: '上周为什么评审不通过的这么多？' }, { from: 'agent', text: '上周 9 个任务里有 4 个在评审被打回，原因都是改动没有对应的测试。' }] },
]

export const paneProcess = [
  { who: '规格 agent · 提问', when: '12 分钟前', text: '导出的 CSV 是否包含已中止的任务？列表页现在是显示的。另外，文件编码用 UTF-8 还是带 BOM 的 UTF-8？' },
  { who: '规格 agent · 读了 3 个文件', when: '14 分钟前', text: 'web/src/App.tsx、src/web/server.ts、src/store/store.ts' },
  { who: '你 · 需求', when: '16 分钟前', text: '任务列表加一个导出 CSV 的按钮。' },
]

export const paneFiles: [string, string][] = [
  ['web/src/App.tsx', '+48 −12'],
  ['web/src/api.ts', '+9 −2'],
  ['src/web/server.ts', '+21 −4'],
  ['tests/web.tasks-filter.test.ts', '+64'],
]
