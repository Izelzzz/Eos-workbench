// 对话页原型的假数据。正式页面里这些来自平台接口

export type TaskDraft = { kind: 'task'; title: string; repo: string; workflow: string; need: string }
/** 一个阶段。没改的只有名字；改了的写明改了什么。change 不写表示「改了内容」 */
export type StageChange = { stage: string; summary?: string; detail?: string; change?: 'added' | 'removed' }
export type WorkflowChange = { kind: 'workflow'; name: string; nextVersion: number; stages: StageChange[]; widens?: string }
export const REPOS = ['eos-workbench', 'eos-docs', 'billing-service']
export const WORKFLOWS = ['standard', 'docs-only', 'release']
export type Message = { from: 'me'; text: string } | { from: 'agent'; text: string; card?: TaskDraft | WorkflowChange }
export type Conversation = { id: string; title: string; when: string; group: '最近 7 天' | '更早'; outcome: string; messages: Message[] }


export const conversations: Conversation[] = [
  {
    id: 'c1',
    title: '给开发阶段加一条检查',
    when: '昨天',
    group: '最近 7 天',
    outcome: '提议修改 standard 工作流，还没保存',
    messages: [
      { from: 'me', text: '最近好几个任务评审时才发现没写测试。能不能在开发阶段就拦住？另外评审最多 5 轮太多了，改成 3 轮。' },
      {
        from: 'agent',
        text: '可以。我看了最近 4 个被评审打回的任务，都是开发阶段没有补测试。下面是对 standard 工作流的两处修改。',
        card: {
          kind: 'workflow',
          name: 'standard',
          nextVersion: 13,
          stages: [
            { stage: '规格' },
            { stage: '开发', summary: '新增 1 条检查', detail: '改动了 src/ 下的文件时，tests/ 下也要有改动。不满足时交回开发 agent。' },
            { stage: '测试' },
            { stage: '评审', summary: '轮数 5 → 3', detail: '最多轮数从 5 改成 3。3 轮不通过时请规格 agent 重新确认。' },
            { stage: '交付' },
          ],
        },
      },
    ],
  },
  {
    id: 'c7',
    title: '发布流程加一步安全扫描',
    when: '昨天',
    group: '最近 7 天',
    outcome: '提议修改 release 工作流，还没保存',
    messages: [
      { from: 'me', text: 'release 流程在集成测试后面加一步安全扫描；文档那一步去掉，合到开发里；预发布的等待从 30 分钟改成 10 分钟。' },
      {
        from: 'agent',
        text: '可以。release 一共 12 个阶段，这次动 4 个。',
        card: {
          kind: 'workflow',
          name: 'release',
          nextVersion: 8,
          stages: [
            { stage: '需求澄清' },
            { stage: '规格' },
            { stage: '设计评审' },
            { stage: '开发', summary: '多交一份文档', detail: '开发阶段的产出增加 docs/changes.md 以外的使用说明。' },
            { stage: '单元测试' },
            { stage: '集成测试' },
            { stage: '安全扫描', summary: '新增', change: 'added', detail: '运行 npm audit 和 trivy；有高危时交回开发 agent。' },
            { stage: '评审' },
            { stage: '文档', summary: '删除', change: 'removed', detail: '并进开发阶段。' },
            { stage: '预发布', summary: '等待 30 → 10 分钟', detail: '预发布环境的观察时间从 30 分钟改成 10 分钟。' },
            { stage: '验收' },
            { stage: '交付' },
          ],
        },
      },
    ],
  },
  {
    id: 'c2',
    title: '让开发 agent 能改 CI 配置',
    when: '2 天前',
    group: '最近 7 天',
    outcome: '提议修改 Agent 模板 developer，还没保存',
    messages: [
      { from: 'me', text: '开发 agent 现在改不了 .github 下的文件，有的任务要改 CI。放开吧。' },
      {
        from: 'agent',
        text: '可以放开，但这是放宽权限：CI 配置能决定检查怎么跑。下面是修改，保存前要你多确认一步。',
        card: {
          kind: 'workflow',
          name: 'developer（Agent 模板）',
          nextVersion: 5,
          stages: [{ stage: '规格' }, { stage: '开发', summary: '可写路径 +1', detail: '开发 agent 可以修改的路径增加 .github/。' }, { stage: '测试' }, { stage: '评审' }, { stage: '交付' }],
          widens: '开发 agent 可以修改的路径增加：.github/',
        },
      },
    ],
  },
  {
    id: 'c3',
    title: '任务列表支持按状态筛选',
    when: '3 天前',
    group: '最近 7 天',
    outcome: '创建了 1 个任务',
    messages: [
      { from: 'me', text: '任务列表页加一个按状态筛选，可以多选。' },
      { from: 'agent', text: '我按这个需求准备了一个任务。', card: { kind: 'task', title: '任务列表支持按状态筛选', repo: 'eos-workbench', workflow: 'standard', need: '任务列表页增加按状态筛选，可以多选。' } },
    ],
  },
  { id: 'c4', title: '上周为什么评审不通过的多', when: '5 天前', group: '最近 7 天', outcome: '只是问答', messages: [{ from: 'me', text: '上周为什么评审不通过的这么多？' }, { from: 'agent', text: '上周 9 个任务里有 4 个在评审被打回，原因都是改动没有对应的测试。要不要我提一条改进，在开发阶段就检查？' }] },
  { id: 'c5', title: '评审 agent 的模板太啰嗦', when: '11 月 14 日', group: '更早', outcome: '保存了 Agent 模板 reviewer 第 4 版', messages: [{ from: 'me', text: '评审 agent 每次都写一大段客套话，改短。' }, { from: 'agent', text: '改好了，已保存为 reviewer 第 4 版。' }] },
  { id: 'c6', title: '做一个只改文档的工作流', when: '11 月 9 日', group: '更早', outcome: '保存了工作流 docs-only 第 1 版', messages: [{ from: 'me', text: '做一个只改文档的工作流，不用跑测试。' }, { from: 'agent', text: '做好了，已保存为 docs-only 第 1 版：规格、编写、评审、交付。' }] },
]
