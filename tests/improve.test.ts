import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { Conventions } from '../src/conventions/conventions.ts'
import { isCheck } from '../src/engine/types.ts'
import type { AgentSpec, Executor, Reply } from '../src/executor/types.ts'
import { generate } from '../src/improve/generate.ts'
import { acquire } from '../src/runner/lock.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import { permissionChanges } from '../src/improve/guard.ts'
import { MAX_PROPOSALS, parseProposals } from '../src/improve/parse.ts'
import { selectScope } from '../src/improve/prompt.ts'
import { Store } from '../src/store/store.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import type { Workflow } from '../src/workflow/types.ts'
import { CHANGES, PASS, workflow } from './helpers.ts'

/** 记下每次调用的提示词和 spec，按剧本回复。 */
class Recorder implements Executor {
  calls: { key: string; prompt: string; spec: AgentSpec }[] = []
  released: string[] = []
  constructor(
    private readonly reply: (prompt: string) => string,
    private readonly opts: { tools?: string[]; releaseFails?: boolean } = {},
  ) {}
  async send(p: { key: string; prompt: string; spec: AgentSpec; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    this.calls.push(p)
    for (const name of this.opts.tools ?? []) p.onEvent?.({ kind: 'tool_start', t: 1, step: 1, id: name, name, args: '{}' })
    return { sessionId: 's', text: this.reply(p.prompt), usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }, ms: 3000, model: 'deepseek-flash' }
  }
  async findReply() {
    return undefined
  }
  async traceOf() {
    return []
  }
  async release(cwd: string) {
    this.released.push(cwd)
    if (this.opts.releaseFails === true) throw new Error('进程已经不在了')
  }
  async close() {}
}

/** 开发角色用 developer 模板第 1 版和 write-changes 技能。 */
const wf = (): Workflow => {
  const w = workflow({ maxRounds: 2, escalate: false })
  return { ...w, roles: { ...w.roles, dev: { ...w.roles.dev!, template: { name: 'developer', version: 1 }, skills: ['write-changes'] } } }
}

const setup = () => {
  const dataDir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-improve-'))
  const store = new Store(':memory:')
  const conventions = new Conventions(store)
  conventions.seed(1)
  let at = 100
  /** 用真实引擎把任务推进完：replies 依次回复调用，检查一律通过。 */
  const task = (id: string, replies: string[], docNames: string[] = []) => {
    const docs = docNames.map(name => ({ name, version: store.convention('doc', name)!.version, content: store.convention('doc', name)!.content }))
    store.create(
      {
        id,
        request: '需求',
        workflow: wf(),
        workflowSource: 'y',
        docs,
        meta: {
          repo: 'r',
          worktree: 'w',
          branch: 'b',
          baseSha: 'x',
          conventions: { workflow: { name: 't' }, docs: [], templates: [{ name: 'developer', version: 1 }], skills: [{ name: 'write-changes', version: 1 }] },
        },
      },
      at++,
    )
    for (const text of replies) {
      const p = store.get(id)!.pending!
      assert.ok(!isCheck(p))
      store.dispatch(id, { kind: 'replied', call: p.id, sessionId: `s-${p.session}`, text, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, ms: 5 }, at++, 'executor')
    }
    return store.get(id)!
  }
  const run = (executor: Executor, over: { tasks?: string[] } = {}) => generate({ store, conventions, executor, dataDir, workflow: 't', actor: 'cli', now: () => 5000, ...over })
  return { store, conventions, dataDir, task, run, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

const DEV1 = (store: Store) => store.convention('template', 'developer')!.content
const withRule = (content: string) => content.trimEnd() + '\n  - 每个导出的函数都要写带 @example 的 JSDoc。\n'
const json = (proposals: unknown[]) => `分析如下……\n\`\`\`json\n${JSON.stringify({ proposals })}\n\`\`\``

test('generation sends the evidence and current contents to a read-only improver with no tools, and stores only checked proposals', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    s.task('b', ['方案', '实现', PASS])
    const ex = new Recorder(() =>
      json([
        { target: { kind: 'template', name: 'developer' }, rationale: '评审要求补测试', evidence: ['a:2', 'a:2'], content: withRule(DEV1(s.store)) },
        { target: { kind: 'skill', name: 'write-changes' }, rationale: '同上', evidence: ['a:99'], content: 'x' },
        { target: { kind: 'template', name: 'reviewer' }, rationale: '放松评审', evidence: ['a:2'], content: 'x' },
        { target: { kind: 'template', name: 'developer' }, rationale: '重复', evidence: ['a:2'], content: 'y' },
        { target: { kind: 'nope' }, evidence: [] },
        { target: { kind: 'doc', name: 'x' }, rationale: 'r', evidence: [''], content: 'c' },
        'x',
      ]),
    )
    const before = s.store.convention('template', 'developer')!.version
    const r = await s.run(ex)
    assert.ok(r.ok, !r.ok ? r.error : '')
    // 一次调用，只读、去掉全部工具组、不挂技能和 MCP，工作目录是数据目录里的空目录，用完释放。
    assert.equal(ex.calls.length, 1)
    const { spec, prompt } = ex.calls[0]!
    assert.deepEqual(
      [spec.write, spec.profile.denyTools, spec.profile.skills, spec.profile.mcp, spec.profile.background],
      ['none', ['web', 'subagent', 'bash', 'schedule', 'todo', 'goal'], [], [], false],
    )
    assert.equal(spec.cwd, join(s.dataDir, 'improve', r.run))
    assert.deepEqual(ex.released, [spec.cwd])
    assert.deepEqual(readdirSync(join(s.dataDir, 'improve')), [], 'the empty working directory is removed afterwards')
    assert.match(prompt, /^你负责改进团队的研发约定/)
    assert.match(prompt, /### a:2｜评审要求修改｜任务 a，节点 review，被评判的角色 dev（模板 developer）\n```\n缺少测试\n1\. \[major\]：补测试\n```/)
    assert.match(prompt, /工作流「t」的 2 个已结束的任务：a、b/)
    assert.match(prompt, /Agent 模板「developer」：2 个任务用到，其中 1 个有证据（评审要求修改 1）/)
    assert.ok(prompt.includes(`### template developer（当前第 1 版）\n\`\`\`\n${DEV1(s.store).trimEnd()}\n\`\`\``))
    assert.doesNotMatch(prompt, /### template reviewer/, 'conventions without evidence are not offered')

    assert.deepEqual(
      r.created.map(p => [p.id, p.target.name, p.baseVersion, p.evidence, p.status, p.scope, p.generator?.run]),
      [[1, 'developer', 1, ['a:2'], 'pending', { workflow: 't', tasks: ['a', 'b'] }, r.run]],
    )
    assert.deepEqual(
      r.refused.map(x => [x.index, x.errors]),
      [
        [1, ['引用了不存在的证据：a:99']],
        [2, ['目标不在这次的范围里（只能改这些任务用到、并且有证据的约定）']],
        [3, ['同一个约定只能有一条提案']],
        [4, ['目标种类格式不对', '目标名字格式不对', '新内容格式不对', '理由格式不对', '证据格式不对']],
        [5, ['证据格式不对']],
        [6, ['提案格式不对']],
      ],
    )
    assert.equal(s.store.convention('template', 'developer')!.version, before, 'generation never changes a convention')
  } finally {
    s.cleanup()
  }
})

test('proposals that change permissions or fail the save validation are refused; a team edit of the improver template cannot widen it', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const loosened = s.store
      .convention('template', 'improver')!
      .content.replace('write: none', 'write: worktree')
      .replace(/tools:\n  deny: \[.*\]\n/, '')
    assert.ok(s.conventions.save({ kind: 'template', name: 'improver', content: loosened, actor: 'web' }, 2).ok)
    const ex = new Recorder(() =>
      json([
        {
          target: { kind: 'template', name: 'developer' },
          rationale: '多给点权限',
          evidence: ['a:2'],
          content: DEV1(s.store).replace('write: worktree', 'write: worktree\nmcp: [{ name: x, command: node }]').replace('  deny: [subagent, schedule]', '  deny: []'),
        },
        { target: { kind: 'skill', name: 'write-changes' }, rationale: '格式坏了', evidence: ['a:2'], content: '没有 front matter' },
      ]),
    )
    const r = await s.run(ex)
    assert.ok(r.ok)
    assert.deepEqual([ex.calls[0]!.spec.write, ex.calls[0]!.spec.profile.denyTools.length], ['none', 6])
    assert.deepEqual(r.created, [])
    assert.deepEqual(
      r.refused.map(x => x.errors),
      [['不能改模板的 tools', '不能改模板的 mcp'], [r.refused[1]!.errors[0]]],
    )
    assert.match(r.refused[1]!.errors[0]!, /^新内容不合格：\(开头\)：技能要以 --- 开头/)
  } finally {
    s.cleanup()
  }
})

test('without evidence the model is not called; unfinished, unknown or missing tasks and unparsable replies are errors', async () => {
  const s = setup()
  try {
    const ex = new Recorder(() => '没有 JSON')
    assert.deepEqual(await s.run(ex), { ok: false, cause: 'input', error: '工作流「t」还没有已结束的任务' })
    s.task('clean', ['方案', '实现', PASS])
    const none = await s.run(ex)
    assert.ok(none.ok)
    assert.deepEqual([none.skipped, ex.calls.length], ['1 个任务里没有证据（评审都一次通过、检查都通过），不生成提案', 0])
    s.task('open', ['方案'])
    assert.deepEqual(await s.run(ex, { tasks: ['open'] }), { ok: false, cause: 'input', error: '这些任务还没结束：open' })
    assert.deepEqual(await s.run(ex, { tasks: ['clean', 'ghost'] }), { ok: false, cause: 'input', error: '这些任务不存在或不是工作流「t」的：ghost' })
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    // 不给任务列表时只看已结束的任务（open 不算进去，也不报错）。
    const r = await s.run(ex)
    assert.ok(!r.ok)
    assert.equal(r.error, 'improver 的回复无法解析：回复里没有 {"proposals": [...]} 格式的 JSON')
    assert.match(ex.calls[0]!.prompt, /工作流「t」的 2 个已结束的任务：clean、a。/)
  } finally {
    s.cleanup()
  }
})

test('an unparsable reply is an error and stores nothing', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const r = await s.run(new Recorder(() => '我觉得还行'))
    assert.ok(!r.ok)
    // 调用过模型之后才失败：用量和原始回复不丢。
    assert.deepEqual([r.error, r.call?.reply, r.call?.usage.output, typeof r.run], ['improver 的回复无法解析：回复里没有 {"proposals": [...]} 格式的 JSON', '我觉得还行', 200, 'string'])
    assert.deepEqual(s.store.proposals(), [])
  } finally {
    s.cleanup()
  }
})

test('the parser drops duplicate evidence ids and accepts an empty list', () => {
  const scope = { targets: [{ kind: 'doc' as const, name: 'a' }], signals: new Set(['t:1']) }
  const r = parseProposals(json([{ target: { kind: 'doc', name: 'a' }, rationale: 'r', evidence: ['t:1', ' t:1 '], content: 'c' }]), scope)
  assert.ok(r.ok)
  assert.deepEqual(r.proposals[0]!.evidence, ['t:1'])
  assert.deepEqual(parseProposals('```json\n{"proposals": []}\n```', scope), { ok: true, proposals: [], refused: [] })
})

test('the limit counts only proposals that pass every check: a refused one does not use up a slot', async () => {
  const s = setup()
  try {
    for (const d of ['d2', 'd3', 'd4']) assert.ok(s.conventions.save({ kind: 'doc', name: d, content: `# ${d}\n`, actor: 'web' }, 2).ok)
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS], ['研发约定', 'd2', 'd3', 'd4'])
    const doc = (name: string) => ({ target: { kind: 'doc', name }, rationale: '补规则', evidence: ['a:2'], content: `# ${name}\n\n- 导出函数写 @example。\n` })
    const r = await s.run(
      new Recorder(() =>
        json([
          { target: { kind: 'template', name: 'developer' }, rationale: '放开 bash', evidence: ['a:2'], content: DEV1(s.store).replace('  deny: [subagent, schedule]', '  deny: []') },
          doc('d2'),
          doc('d3'),
          doc('d4'),
          doc('研发约定'),
        ]),
      ),
    )
    assert.ok(r.ok)
    assert.deepEqual(
      r.created.map(p => p.target.name),
      ['d2', 'd3', 'd4'],
    )
    assert.deepEqual(
      r.refused.map(x => [x.index, x.errors]),
      [
        [0, ['不能改模板的 tools']],
        [4, [`一次最多 ${MAX_PROPOSALS} 条提案`]],
      ],
    )
  } finally {
    s.cleanup()
  }
})

test('permission guard: template permission fields, workflow role permissions, new writable roles and check commands', () => {
  const t = (extra = '', deny = '[subagent, schedule]') => `name: developer\nmodel: deepseek-flash\nwrite: worktree\nwritePaths: [src/**]\ntools:\n  deny: ${deny}\nprompt: 写代码${extra}\n`
  assert.deepEqual(
    permissionChanges('template', t(), t('，写测试'), () => undefined),
    [],
    'prompt changes are fine',
  )
  assert.deepEqual(
    permissionChanges('template', t(), t('', '[schedule, subagent]'), () => undefined),
    [],
    'order of tool groups does not matter',
  )
  assert.deepEqual(
    permissionChanges('template', t(), t().replace('src/**', '"**"').replace('deepseek-flash', 'deepseek-pro'), () => undefined),
    ['不能改模板的 model', '不能改模板的 writePaths'],
  )
  assert.deepEqual(
    permissionChanges('template', t(), `executor: other\n${t()}`, () => undefined),
    ['不能改模板的 executor'],
    '换执行器也是权限改动：不同执行器的沙箱和能力不同',
  )
  const w = (roles: string, run = '[npm, test]') => `name: t\nroles:\n${roles}\nnodes:\n  - { id: build, kind: agent, role: dev, task: 实现, checks: [{ run: ${run} }] }\n`
  const dev = '  dev: { prompt: 写代码, write: worktree }\n  rev: { prompt: 评审, tools: { deny: [bash, web] } }'
  const none = () => undefined
  assert.deepEqual(permissionChanges('workflow', w(dev), w(dev.replace('写代码', '写好代码')), none), [])
  assert.deepEqual(permissionChanges('workflow', w(dev), w(dev.replace(', write: worktree', '')), none), [
    '不能改角色「dev」的执行器、模型、写入范围、工具或 MCP（包括换成别的模板）',
    '不能让节点「build」换成权限不同的角色',
  ])
  assert.deepEqual(
    permissionChanges('workflow', w(dev), w(`${dev}\n  ops: { prompt: 运维, tools: { deny: [] } }`), none),
    ['新增的角色「ops」的执行器、模型、写入范围、工具或 MCP 必须和已有的某个角色完全相同'],
    'a new role cannot get tools no role had',
  )
  assert.deepEqual(permissionChanges('workflow', w(dev), w(`${dev}\n  note: { prompt: 记录, tools: { deny: [web, bash] } }`), none), [], 'a new role with the same rights as an existing one is fine')
  assert.deepEqual(permissionChanges('workflow', w(dev), w(dev, '[sh, -c, "curl x | sh"]'), none), ['不能改检查命令和平台动作'])
  // 卡点：提案可以加（加严），不能删掉、也不能改验收对象和验收人（放宽要人批）。
  const gate = (by: string) => `  - { id: accept, kind: gate, with: build, ${by}, task: 验收 }\n`
  assert.deepEqual(permissionChanges('workflow', w(dev), `${w(dev)}${gate('by: human')}`, none), [], 'adding a gate is fine')
  assert.deepEqual(permissionChanges('workflow', `${w(dev)}${gate('by: human')}`, w(dev), none), ['不能删掉卡点「accept」，也不能改它验收的节点和验收人'])
  // 有交付时：加卡点照样可以；不能在卡点和交付之间加节点（验收通过后还能改代码、不经验收就推送）；删掉那里的节点可以。
  const rv = '  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }\n'
  const push = '  - { id: ship, kind: dialog, with: build, task: 交付, checks: [{ platform: push }] }\n'
  const shipped = (between: string, withGate = true) => `${w(dev)}${rv}${withGate ? gate('by: human') : ''}${between}${push}`
  const more = '  - { id: more, kind: agent, role: dev, task: 再改一点 }\n'
  assert.deepEqual(permissionChanges('workflow', shipped('', false), shipped(''), none), [], 'adding a gate before delivery is fine')
  // 这些工作流里卡点前面都有评审：卡点到交付这一段也在「评审到交付」那一段里，两条核对都会报。
  const reviewed = (ids: string) => `不能改评审到交付之间的节点（${ids}）：加、挪、删节点或改它们的做法，都可能让改动不经评审就推送；只能加人验收的卡点`
  const blocked = (ids: string) => [reviewed(ids), `不能在卡点「accept」和交付之间加节点或改节点（${ids}）：验收通过之后的改动会不经验收就推送`]
  assert.deepEqual(permissionChanges('workflow', shipped(''), shipped(more), none), blocked('more'))
  assert.deepEqual(permissionChanges('workflow', shipped(more), shipped(''), none), [reviewed('more')], '卡点在评审后面：删掉评审到交付之间的节点也拦下')
  assert.deepEqual(permissionChanges('workflow', shipped(more), shipped(more.replace('再改一点', '再改好一点')), none), [], 'changing only the task text is fine')
  // 加 agent 验收的卡点：打回时会交回开发改代码，不算加严。人验收的卡点可以加。
  const agentGate = '  - { id: g2, kind: gate, with: build, by: agent, role: rev, task: 再验 }\n'
  assert.deepEqual(permissionChanges('workflow', shipped(''), shipped(agentGate), none), blocked('g2'))
  assert.deepEqual(permissionChanges('workflow', shipped(''), shipped(agentGate.replace('g2', 'g3').replace('by: agent, role: rev', 'by: human')), none), [])
  // 改已有节点的做法（换 with）也拦下。
  const docs = `${w(`${dev}\n  doc: { prompt: 写文档, write: worktree }`).replace('nodes:\n', 'nodes:\n  - { id: docs, kind: agent, role: doc, task: 文档 }\n')}${rv}${gate('by: human')}`
  const chk = (target: string) => `${docs}  - { id: chk, kind: dialog, role: rev, with: ${target}, task: 查 }\n${push}`
  assert.deepEqual(permissionChanges('workflow', chk('docs'), chk('build'), none), blocked('chk'))
  // 两个交付节点之间加节点：pull-request 也会推送，一样拦下。
  const pr = '  - { id: pr, kind: dialog, with: build, task: 开 PR, checks: [{ platform: pull-request }] }\n'
  assert.deepEqual(permissionChanges('workflow', shipped('') + pr, shipped('') + more + pr, none), blocked('more'))
  assert.deepEqual(permissionChanges('workflow', `${w(dev)}${gate('by: human')}`, `${w(dev)}${gate('by: agent, role: rev')}`, none), [
    '不能让节点「accept」换成权限不同的角色',
    '不能删掉卡点「accept」，也不能改它验收的节点和验收人',
  ])
  // 平台动作（推送分支）也是平台替 agent 做的：改进提案不能加也不能删。
  const review = '  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }\n'
  const ship = '  - { id: ship, kind: dialog, with: build, task: 交付, checks: [{ platform: push }] }\n'
  const withPush = (roles: string) => `${w(roles)}${review}${ship}`
  assert.ok(parseWorkflow(withPush(dev)).ok)
  // 不能删掉推送前的评审，也不能把交付挪到评审前面（挪了解析就不通过，删掉评审换成别的评审也算改了）。
  const otherReview = `${w(dev)}  - { id: check2, kind: dialog, role: rev, with: build, task: 另一个评审 }\n${ship}`
  assert.ok(parseWorkflow(otherReview).ok)
  assert.deepEqual(permissionChanges('workflow', withPush(dev), otherReview, none), ['不能改检查命令和平台动作', reviewed('review、check2')])
  const extraBefore = `${w(dev)}${review}  - { id: check2, kind: dialog, role: rev, with: build, task: 再评审一次 }\n${ship}`
  assert.deepEqual(permissionChanges('workflow', withPush(dev), extraBefore, none), ['不能改检查命令和平台动作', reviewed('check2')], '推送前的评审有变化也要人改')
  assert.deepEqual(permissionChanges('workflow', w(dev), withPush(dev), none), ['不能改检查命令和平台动作'])
  assert.deepEqual(permissionChanges('workflow', withPush(dev), w(dev), none), ['不能改检查命令和平台动作', reviewed('review、ship')])
  // 评审到交付这一段（没有卡点的工作流）：加、挪、删节点，改评审的 with，删评审，都拦下。
  const flow = (before: string, between: string, target = 'build') =>
    `${w(`${dev}\n  doc: { prompt: 写文档, write: worktree }`).replace('nodes:\n', 'nodes:\n  - { id: docs, kind: agent, role: doc, task: 文档 }\n')}${before}  - { id: review, kind: dialog, role: rev, with: ${target}, task: 评审 }\n${between}${ship}`
  const tweak = '  - { id: tweak, kind: agent, role: dev, task: 再改一点 }\n'
  const test = '  - { id: test, kind: dialog, with: build, task: 测试, checks: [{ run: [npm, test] }] }\n'
  assert.ok(parseWorkflow(flow('', tweak)).ok)
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow('', tweak), none), [reviewed('tweak')], '评审和交付之间加节点')
  assert.deepEqual(permissionChanges('workflow', flow(tweak, ''), flow('', tweak), none), [reviewed('tweak')], '把节点挪到评审和交付之间')
  assert.deepEqual(permissionChanges('workflow', flow('', tweak), flow('', ''), none), [reviewed('tweak')], '删掉评审和交付之间的节点')
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow('', '', 'docs'), none), [reviewed('review')], '换评审的 with')
  // 删掉评审（还剩另一个评审，否则保存校验就不通过）。
  const review2 = '  - { id: review2, kind: dialog, role: rev, with: build, task: 复审 }\n'
  assert.deepEqual(
    permissionChanges('workflow', flow('', review2), flow('', review2).replace('  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }\n', ''), none),
    ['不能改检查命令和平台动作', reviewed('review')],
    '删掉评审',
  )
  assert.deepEqual(permissionChanges('workflow', flow('', test + tweak), flow('', tweak + test), none), [reviewed('顺序')], '只调换顺序也拦下')
  // 合法的提案不拦：改工作说明、改角色的提示词、在评审前面加 agent 节点、加人验收的卡点。
  assert.deepEqual(permissionChanges('workflow', flow('', tweak), flow('', tweak.replace('再改一点', '再改好一点')).replace('task: 评审', 'task: 认真评审'), none), [])
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow('', '').replace('写文档', '写清楚的文档'), none), [])
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow(tweak, ''), none), [], '评审前面加 agent 节点不在这一段里')
  // 两个交付节点之间加节点（没有卡点）：pull-request 也会推送，一样拦下。
  const pr2 = '  - { id: pr, kind: dialog, with: build, task: 开 PR, checks: [{ platform: pull-request }] }\n'
  assert.deepEqual(permissionChanges('workflow', flow('', '') + pr2, flow('', '') + tweak + pr2, none), [reviewed('tweak')])
  // 卡点的检查是从别的节点算出来的：给 build 加交付物，不记到 agent 验收的卡点头上。
  const signed = (extra: string) => flow('', '  - { id: sign, kind: gate, with: build, by: agent, role: rev, task: 签字 }\n').replace('task: 实现', `task: 实现${extra}`)
  assert.deepEqual(permissionChanges('workflow', signed(''), signed(', deliverables: [{ path: NOTES.md }]'), none), [])
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow('', '  - { id: ok, kind: gate, with: build, by: human, task: 验收 }\n'), none), [])
  // 误拦（失败就关，交给人在团队约定页改）：这一段里加严的改动，例如给交付节点加 maxRounds: 1；
  // 在评审前面再加一个评审或测试的对话节点（这一段从第一个对话节点算起，起点往前挪了）。
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow('  - { id: pre, kind: dialog, role: rev, with: build, task: 预审 }\n', ''), none), ['不能改检查命令和平台动作', reviewed('pre')])
  assert.deepEqual(permissionChanges('workflow', flow('', ''), flow('', '').replace('task: 交付,', 'task: 交付, maxRounds: 1,'), none), [reviewed('ship')])
  assert.deepEqual(permissionChanges('workflow', withPush(dev), withPush(dev.replace('写代码', '写好代码')), none), [])
  // 节点换成别的角色、新增节点
  const nodes = (extra: string) =>
    `name: t\nroles:\n${dev}\nnodes:\n  - { id: build, kind: agent, role: dev, task: 实现 }\n  - { id: review, kind: dialog, role: rev, with: build, task: 评审 }${extra}\n`
  assert.deepEqual(permissionChanges('workflow', nodes(''), nodes('').replace('role: rev, with', 'role: dev, with'), none), ['不能让节点「review」换成权限不同的角色'])
  assert.deepEqual(permissionChanges('workflow', nodes(''), nodes('\n  - { id: more, kind: agent, role: dev, task: 再写 }'), none), [], 'a new node using an existing role is fine')
  assert.deepEqual(permissionChanges('workflow', 'name: t\nroles: {}\nnodes: []\n', nodes(''), none), ['当前版本无法解析，不能自动核对权限；请在团队约定页手动修改'], 'fails closed')
  assert.deepEqual(permissionChanges('template', '坏的: [', t(), none), ['当前版本无法解析，不能自动核对权限；请在团队约定页手动修改'])
  assert.deepEqual(
    permissionChanges('doc', 'a', 'b', () => undefined),
    [],
  )
})

test('if the improver calls any tool the whole run is void: nothing is stored, the call is kept', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const r = await s.run(
      new Recorder(() => json([{ target: { kind: 'template', name: 'developer' }, rationale: 'r', evidence: ['a:2'], content: withRule(DEV1(s.store)) }]), { tools: ['read', 'grep', 'read'] }),
    )
    assert.ok(!r.ok)
    assert.equal(r.error, 'improver 调用了工具（read、grep）：需要的内容都在消息里，调用工具说明它可能被证据里的文字引导了，这次生成作废，没有提案入库')
    assert.equal(r.call?.usage.output, 200)
    assert.deepEqual(s.store.proposals(), [])
  } finally {
    s.cleanup()
  }
})

test('contents with code fences parse; a later valid proposal for a target is kept when the earlier one was refused; a failing release still cleans up', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const skill = s.store.convention('skill', 'write-changes')!.content
    const withFence = `${skill.trimEnd()}\n\n例子：\n\n\`\`\`md\n## 改动\n- src/sum.js：新增 sum\n\`\`\`\n`
    const reply = `先说明一下：\n\`\`\`json\n${JSON.stringify(
      {
        proposals: [
          { target: { kind: 'template', name: 'developer' }, rationale: '放开 bash', evidence: ['a:2'], content: DEV1(s.store).replace('  deny: [subagent, schedule]', '  deny: []') },
          { target: { kind: 'template', name: 'developer' }, rationale: '只加规则', evidence: ['a:2'], content: withRule(DEV1(s.store)) },
          { target: { kind: 'skill', name: 'write-changes' }, rationale: '加例子', evidence: ['a:2'], content: withFence },
        ],
      },
      null,
      2,
    )}\n\`\`\`\n`
    const ex = new Recorder(() => reply, { releaseFails: true })
    const r = await s.run(ex)
    assert.ok(r.ok, !r.ok ? r.error : '')
    assert.deepEqual(
      r.created.map(p => [p.target.name, p.rationale]),
      [
        ['developer', '只加规则'],
        ['write-changes', '加例子'],
      ],
    )
    assert.equal(r.created[1]!.content, withFence)
    assert.deepEqual(
      r.refused.map(x => [x.index, x.errors]),
      [[0, ['不能改模板的 tools']]],
    )
    assert.deepEqual(readdirSync(join(s.dataDir, 'improve')), [])
  } finally {
    s.cleanup()
  }
})

test('a format example repeated in the prose does not replace the real answer; proposals need not be the first key', () => {
  const scope = { targets: [{ kind: 'doc' as const, name: 'a' }], signals: new Set(['t:1']) }
  const real = { proposals: [{ target: { kind: 'doc', name: 'a' }, rationale: 'r', evidence: ['t:1'], content: '# a\n\n```md\n例子\n```\n' }] }
  const echo = parseProposals(`\`\`\`json\n${JSON.stringify(real)}\n\`\`\`\n如果没有值得改的，就给 {"proposals": []}。`, scope)
  assert.ok(echo.ok)
  assert.equal(echo.proposals.length, 1, 'the fenced answer wins over an example in the prose')
  const later = parseProposals(`先举个格式例子 {"proposals": []}，下面是答案：\n${JSON.stringify(real)}`, scope)
  assert.ok(later.ok)
  assert.equal(later.proposals.length, 1, 'without a fence the last object wins')
  const notFirst = parseProposals(`\`\`\`json\n${JSON.stringify({ note: '说明', ...real })}\n\`\`\``, scope)
  assert.ok(notFirst.ok)
  assert.equal(notFirst.proposals[0]!.content, real.proposals[0]!.content)
})

test('a tool call the model sent counts even without a tool_start event', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const ex = new Recorder(() => json([]))
    const send = ex.send.bind(ex)
    ex.send = async p => {
      p.onEvent?.({ kind: 'model', t: 1, step: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, reasoning: '', text: '', toolCalls: [{ id: 'x', name: 'read', args: '{}' }] })
      return send(p)
    }
    const r = await s.run(ex)
    assert.ok(!r.ok)
    assert.match(r.error, /^improver 调用了工具（read）/)
  } finally {
    s.cleanup()
  }
})

test('without any candidate convention on the platform the model is not called', async () => {
  const s = setup()
  try {
    // 评审方 rev 直接写在工作流里，工作流 t 不在平台上：格式重试的证据没有可改的约定。
    s.task('a', ['方案', '实现', '我觉得还行', PASS])
    const ex = new Recorder(() => json([]))
    const r = await s.run(ex)
    assert.ok(r.ok)
    assert.deepEqual([r.skipped, ex.calls.length], ['证据涉及的约定都不在平台上（例如工作流来自 YAML 文件），没有可以修改的约定，不生成提案', 0])
  } finally {
    s.cleanup()
  }
})

test('one generation at a time per data directory: a held lock is reported as busy and nothing is called', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const lock = acquire(join(s.dataDir, 'locks'), 'improve', 1) // pid 1 一直活着：模拟另一个进程正在生成
    const ex = new Recorder(() => json([]))
    try {
      const r = await s.run(ex)
      assert.deepEqual(r, { ok: false, cause: 'busy', error: '已经有一次生成在进行（网页或命令行发起的，进程 1），等它结束再试' })
      assert.equal(ex.calls.length, 0)
    } finally {
      if ('release' in lock) lock.release()
    }
    assert.ok((await s.run(ex)).ok, 'after the other run ends, generation works again')
  } finally {
    s.cleanup()
  }
})

test('candidates are taken from conventions on the platform before the limit: many off-platform targets do not crowd them out', () => {
  const t = (name: string, n: number) => ({ kind: 'doc' as const, name, versions: [], tasks: 1, affected: 1, counts: {}, signals: Array.from({ length: n }, (_, i) => `${name}:${i}`) })
  const targets = [...['y1', 'y2', 'y3', 'y4', 'y5', 'y6'].map(n => t(n, 5)), t('team', 1)]
  const signals = targets.flatMap(x => x.signals).map(id => ({ id, task: 'a', entry: 0, at: 0, kind: 'review_changes' as const, text: '' }))
  const r = selectScope({ signals, targets }, x => x.name === 'team')
  assert.deepEqual(
    r.targets.map(x => x.name),
    ['team'],
  )
})

test('improver 模板写了 executor 时，生成用那个执行器（不写时用默认的）', async () => {
  const s = setup()
  try {
    s.task('a', ['方案', '实现', CHANGES, '改了', PASS])
    const ex = new Recorder(() => json([]))
    assert.equal((await s.run(ex)).ok, true)
    assert.equal(ex.calls[0]!.spec.executor, undefined)
    const content = s.store.convention('template', 'improver')!.content.replace(/^name: improver$/m, 'name: improver\nexecutor: other')
    assert.ok(s.conventions.save({ kind: 'template', name: 'improver', content, actor: 'web' }, 2).ok)
    assert.equal((await s.run(ex)).ok, true)
    assert.equal(ex.calls[1]!.spec.executor, 'other')
  } finally {
    s.cleanup()
  }
})
