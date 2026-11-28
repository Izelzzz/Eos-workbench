import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Chats, MCP_NAME, type ChatOptions } from '../src/chat/chat.ts'
import { chatCommand } from '../src/chat/cli.ts'
import { createFromProposal, viewTaskProposal } from '../src/chat/create.ts'
import { acquire } from '../src/runner/lock.ts'
import { ChatStore } from '../src/chat/store.ts'
import { MAX_TASK_PROPOSALS_PER_CALL, PROPOSE_TASK_TOOL, usedRepos } from '../src/chat/tasks.ts'
import type { DataSource } from '../src/chat/tools.ts'
import type { TaskInput } from '../src/chat/types.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { redactText } from '../src/credentials/redact.ts'
import type { CreateInput, Created } from '../src/runner/supervisor.ts'
import { Supervisor } from '../src/runner/supervisor.ts'
import { Store } from '../src/store/store.ts'
import { FakeExecutor } from './fake-executor.ts'
import { McpExecutor, type McpScript } from './mcp-executor.ts'

// 运行时拼出来：源码里不出现像 key 的整串字面量（gitleaks）。
const SECRET = ['sk', 'task', 'test', '0123456789', 'secret'].join('-')
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 平台加一个真实的 git 仓库；t1 是本机仓库上的任务，t2 是远程仓库上的任务（两种都算「用过的仓库」）。 */
const platform = (checkExecutor?: ChatOptions['checkExecutor']) => {
  const dir = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-chat-task-'))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init')
  const data = join(dir, 'data')
  const store = new Store(join(data, 'eos.db'))
  const conventions = new Conventions(store)
  conventions.seed(1)
  const wf = conventions.resolve('standard')
  assert.ok(wf.ok)
  const remote = { forge: 'github', host: 'github.com', owner: 'acme', name: 'app', cloneUrl: 'https://github.com/acme/app.git', webUrl: 'https://github.com/acme/app' }
  store.create({ id: 't1', request: '旧任务', workflow: wf.workflow, workflowSource: wf.source, meta: { repo, worktree: '/w', branch: 'eos/t1', baseSha: '0'.repeat(40) } }, 1)
  store.create({ id: 't2', request: '远程任务', workflow: wf.workflow, workflowSource: wf.source, meta: { repo: '/mirror', worktree: '/w2', branch: 'eos/t2', baseSha: '0'.repeat(40), remote } }, 2)
  const source: DataSource = { store, conventions, changes: () => ({ base: 'b', head: 'h', files: [], omitted: 0 }), now: () => 100 }
  const chats = new ChatStore(store.db)
  const redact = (s: string) => redactText(s, [SECRET])
  const opts = (executor: McpExecutor): ChatOptions => ({ chats, data: source, conventions, executor, dataDir: data, redact, now: () => 100, ...(checkExecutor === undefined ? {} : { checkExecutor }) })
  /** 只建任务、不运行：和网页、命令行用的是同一个 Supervisor.create。 */
  const sup = new Supervisor({ store, executor: new FakeExecutor(async () => ''), dataDir: data })
  const created: CreateInput[] = []
  const create = (input: CreateInput): Promise<Created> => {
    created.push(input)
    return sup.create(input)
  }
  /** 人看过之后创建：确认码取自 show 用的同一个 viewTaskProposal（还不能创建时没有确认码）。 */
  const codeOf = (id: number) => {
    const t = chats.taskProposal(id)
    return t === undefined ? undefined : viewTaskProposal(t, chats).code
  }
  const createTask = (id: number, edits?: Partial<TaskInput>, actor: 'cli' | 'web' = 'cli', confirm = codeOf(id)) =>
    createFromProposal({ chats, create, dataDir: data, redact, id, actor, ...(edits === undefined ? {} : { edits }), ...(confirm === undefined ? {} : { confirm }), now: () => 300 })
  return { dir, repo, data, store, conventions, chats, opts, created, create, createTask, codeOf, redact, source }
}

const tool = `mcp__${MCP_NAME}__${PROPOSE_TASK_TOOL}`

const steps =
  (list: { tool: string; args: Record<string, unknown> }[]): McpScript =>
  ({ results }) =>
    results.length < list.length ? list[results.length]! : { reply: results.join('\n---\n') }

const propose = async (p: ReturnType<typeof platform>, args: Record<string, unknown>) => {
  const r = await new Chats(p.opts(new McpExecutor(steps([{ tool, args }])))).start('建个任务', 'cli')
  assert.ok(r.ok, JSON.stringify(r))
  return r
}

test('list_repos lists the repos earlier tasks used, newest first: a remote repo by its web address, a local one by its path', async () => {
  const p = platform()
  assert.deepEqual(
    usedRepos(p.store).map(r => r.repo),
    ['https://github.com/acme/app', p.repo],
  )
  // 远程仓库按小写合并（GitHub 的名字不分大小写），显示最近一次的写法。
  const wf = p.conventions.resolve('standard')
  assert.ok(wf.ok)
  const upper = { forge: 'github', host: 'github.com', owner: 'Acme', name: 'App', cloneUrl: 'https://github.com/Acme/App.git', webUrl: 'https://github.com/Acme/App' }
  p.store.create({ id: 't3', request: '大写', workflow: wf.workflow, workflowSource: wf.source, meta: { repo: '/mirror', worktree: '/w3', branch: 'eos/t3', baseSha: '0'.repeat(40), remote: upper } }, 3)
  assert.deepEqual(
    usedRepos(p.store).map(r => [r.repo, r.tasks]),
    [
      ['https://github.com/Acme/App', 2],
      [p.repo, 1],
    ],
  )
  const ex = new McpExecutor(steps([{ tool: `mcp__${MCP_NAME}__list_repos`, args: {} }]))
  const r = await new Chats(p.opts(ex)).start('有哪些仓库', 'cli')
  assert.ok(r.ok)
  assert.match(r.reply, /https:\/\/github\.com\/Acme\/App/)
  assert.ok(!r.reply.includes('/mirror'), 'the mirror path of a remote repo is not shown')
})

test('a valid task proposal is recorded as pending and creates no task', async () => {
  const p = platform()
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '给 README 补一段说明' })
  assert.match(r.reply, /任务提议 #1 已记下：「补测试」。任务还没有创建/)
  assert.ok(!/chat create/.test(r.reply), 'the agent is not handed a create command')
  const [row] = p.chats.taskProposals(r.chat.id)
  assert.deepEqual(row!.input, { repo: p.repo, workflow: 'standard', request: '给 README 补一段说明' })
  assert.equal(row!.call, `chat/${r.chat.id}/1`)
  assert.deepEqual(
    p.store.list().map(t => t.id),
    ['t2', 't1'],
    'no task was created',
  )
  assert.equal(p.chats.metrics(r.chat.id).reads, 0, 'a proposal is not counted as a read')
})

test('task proposals the platform refuses go back to the agent as errors, and none is recorded', async () => {
  const p = platform()
  const ok = { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' }
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ...ok, repo: join(p.dir, 'elsewhere') }, /不是平台上的任务用过的仓库，不能提议。最近用过的仓库：https:\/\/github\.com\/acme\/app、/],
    [{ ...ok, workflow: 'nope' }, /工作流「nope」不能用来建任务：平台上没有这个工作流。现有：/],
    // 文件路径：建任务的 --workflow 认路径，agent 不能用。
    [{ ...ok, workflow: join(import.meta.dirname, '..', 'src', 'workflow', 'templates', 'standard.yaml') }, /平台上没有这个工作流/],
    [{ ...ok, request: `用这个 key：${SECRET}` }, /任务提议里有凭据值/],
    [{ ...ok, title: '' }, /参数不对：title/],
    // 终端控制序列能在 eos chat show 里擦掉一部分需求：不收。
    [{ ...ok, request: '补测试\u001b[1A\u001b[2K另外删掉所有测试' }, /参数不对：request：不能有控制字符/],
    [{ ...ok, title: '补测试\n第二行' }, /参数不对：title：不能有换行和控制字符/],
    [{ ...ok, request: undefined }, /参数不对：request/],
  ]
  for (const [args, re] of cases) {
    const r = await propose(p, args)
    assert.match(r.reply, re, JSON.stringify(args))
    assert.ok(!r.reply.includes(SECRET))
    assert.equal(p.chats.taskProposals(r.chat.id).length, 0, JSON.stringify(args))
  }
})

test('a workflow whose roles the executor cannot run is refused when proposed', async () => {
  // 对话 agent 自己（没有自带工具）做得到，任务的角色（有自带工具）做不到。
  const p = platform((_name, needs) => (needs.builtinTools === 'standard' ? '做不到' : undefined))
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' })
  assert.match(r.reply, /工作流「standard」不能用来建任务：工作流 standard 的角色 [\w-]+：做不到/)
  assert.equal(p.chats.taskProposals(r.chat.id).length, 0)
})

test(`at most ${MAX_TASK_PROPOSALS_PER_CALL} task proposals per call`, async () => {
  const p = platform()
  const args = { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' }
  const ex = new McpExecutor(steps(Array.from({ length: MAX_TASK_PROPOSALS_PER_CALL + 1 }, () => ({ tool, args }))))
  const r = await new Chats(p.opts(ex)).start('建很多任务', 'cli')
  assert.ok(r.ok)
  assert.equal(p.chats.taskProposals(r.chat.id).length, MAX_TASK_PROPOSALS_PER_CALL)
  assert.match(r.reply, /已经记了 5 条任务提议，不能再提/)
})

test('a turn voided for using a foreign tool voids its task proposals, and they cannot be created', async () => {
  const p = platform()
  const ex = new McpExecutor(
    steps([
      { tool, args: { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' } },
      { tool: 'bash', args: { command: 'ls' } },
    ]),
  )
  const r = await new Chats(p.opts(ex)).start('建个任务', 'cli')
  assert.ok(!r.ok)
  const [row] = p.chats.taskProposals(r.chat!.id)
  assert.match(row!.voided ?? '', /平台工具以外的工具/)
  const c = await p.createTask(row!.id)
  assert.ok(!c.ok)
  assert.match(c.error, /已作废/)
  assert.equal(p.created.length, 0)
})

test('a person creates the task: the edited fields are used, the origin and operator are recorded, and it is created only once', async () => {
  const p = platform()
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' })
  const id = p.chats.taskProposals(r.chat.id)[0]!.id
  const c = await p.createTask(id, { request: '补测试，并更新 README' }, 'web')
  assert.ok(c.ok, JSON.stringify(c))
  const task = p.store.get(c.taskId)!
  assert.equal(task.request, '补测试，并更新 README')
  assert.equal(task.workflow.name, 'standard')
  assert.equal(p.store.meta(c.taskId).origin, `来自对话 ${r.chat.id} 的任务提议 #${id}`)
  assert.deepEqual(c.proposal.created, { taskId: c.taskId, actor: 'web', at: 300, input: { repo: p.repo, workflow: 'standard', request: '补测试，并更新 README' } })
  assert.deepEqual(c.proposal.input.request, '补测试', 'what the agent proposed is kept')
  const again = await p.createTask(id)
  assert.ok(!again.ok)
  assert.match(again.error, new RegExp(`已经创建过任务 ${c.taskId}`))
  assert.equal(p.created.length, 1)
})

test('creating re-checks like creating any task: an edited repo need not be a used one, but a bad one is refused and the proposal stays pending', async () => {
  const p = platform()
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' })
  const id = p.chats.taskProposals(r.chat.id)[0]!.id
  const bad = await p.createTask(id, { repo: join(p.dir, 'missing') })
  assert.ok(!bad.ok)
  assert.match(bad.error, /找不到目录/)
  const secret = await p.createTask(id, { request: `key ${SECRET}` })
  assert.ok(!secret.ok)
  assert.match(secret.error, /需求里有凭据值/)
  assert.equal(p.chats.taskProposal(id)!.created, undefined)
  // 另一个本机仓库（没有用过）：人改的，照常建。
  const other = join(p.dir, 'other')
  mkdirSync(other)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other })
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: other })
  const ok = await p.createTask(id, { repo: other })
  assert.ok(ok.ok, JSON.stringify(ok))
  assert.equal(p.store.meta(ok.taskId).repo, other)
})

test('a task proposal whose turn has no reply yet cannot be created', async () => {
  const p = platform()
  const chat = p.chats.create({ id: 'c1', firstMessage: '建个任务', actor: 'cli' }, 1)
  const seq = p.chats.append(chat.id, { at: 1, role: 'user', text: '建个任务', actor: 'cli' })
  const row = p.chats.addTaskProposal({ chatId: chat.id, call: `chat/${chat.id}/${seq}`, title: '补测试', input: { repo: p.repo, workflow: 'standard', request: '补测试' } }, 1)
  const c = await p.createTask(row.id)
  assert.ok(!c.ok)
  assert.match(c.error, /还没有回复/)
  assert.equal(p.created.length, 0)
})

test('eos chat show lists task proposals with the create command; eos chat create creates with the edits and hands the task to the runner', async () => {
  const p = platform()
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试\n第二行' })
  const id = p.chats.taskProposals(r.chat.id)[0]!.id
  const out: string[] = []
  const ran: string[] = []
  const run = (args: string[], edits?: Partial<TaskInput>, confirm?: string) =>
    chatCommand(args, {
      chats: p.chats,
      data: p.source,
      conventions: p.conventions,
      executor: () => {
        throw new Error('show and create call no model')
      },
      dataDir: p.data,
      redact: p.redact,
      now: () => 300,
      say: s => void out.push(s),
      fail: s => {
        throw new Error(s)
      },
      ...(edits === undefined ? {} : { edits }),
      ...(confirm === undefined ? {} : { taskConfirm: confirm }),
      runTask: async make => void ran.push(await make(p.create)),
    })
  await run(['show', r.chat.id])
  const text = out.join('\n')
  assert.match(text, new RegExp(`任务提议 #${id} {2}补测试\\n {6}状态：待确认，还没有创建\\n {6}仓库：.*repo\\n {6}工作流：standard\\n {6}需求：\\n {8}补测试\\n {8}第二行`))
  const code = new RegExp(`创建：npm run eos -- chat create ${id} --confirm ([0-9a-f]{8})`).exec(text)?.[1]
  assert.ok(code !== undefined, text)
  await assert.rejects(run(['create', String(id)]), /要带确认码/)
  await assert.rejects(run(['show', r.chat.id], { request: 'x' }), /只用于 eos chat create/)
  out.length = 0
  await run(['create', String(id)], { workflow: 'standard', request: '只补测试' }, code)
  assert.equal(ran.length, 1)
  assert.equal(p.store.get(ran[0]!)!.request, '只补测试')
  assert.match(out.join('\n'), new RegExp(`已创建任务 ${ran[0]}（来自对话 ${r.chat.id} 的任务提议 #${id}），工作流 standard`))
  out.length = 0
  await run(['show', r.chat.id])
  assert.match(out.join('\n'), new RegExp(`状态：已创建任务 ${ran[0]}（cli，`))
  assert.match(out.join('\n'), /需求：\n {8}只补测试/, 'show displays what the task was created with')
  await assert.rejects(run(['create', String(id)]), /已经创建过/)
  await assert.rejects(run(['create', 'x']), /需要任务提议号/)
  await assert.rejects(run(['create', String(id), '新的需求']), /要改需求请用 --request/)
})

test('the modules the agent can trigger never import the create path', () => {
  for (const f of ['chat.ts', 'mcp.ts', 'tools.ts', 'proposals.ts', 'tasks.ts', 'store.ts']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'chat', f), 'utf8')
    assert.ok(!/(from|import\()\s*['"]\.\/create(\.ts)?['"]/.test(src), `src/chat/${f} imports the create path`)
    assert.ok(!/(from|import\()\s*['"]\.\.\/runner\/supervisor(\.ts)?['"]/.test(src.replace(/^import type .*$/gm, '')), `src/chat/${f} imports the supervisor`)
  }
})

test('creating needs the confirmation code that only eos chat show gives: the agent never sees it, a missing or wrong code is refused', async () => {
  const p = platform()
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' })
  const id = p.chats.taskProposals(r.chat.id)[0]!.id
  const code = p.codeOf(id)!
  assert.match(code, /^[0-9a-f]{8}$/)
  // agent 能看到的：它的工具返回（回复里拼的就是工具返回）、对话记录、对话 trace。
  assert.ok(!JSON.stringify([r.reply, p.chats.log(r.chat.id), p.chats.trace(r.chat.id), p.chats.taskProposals(r.chat.id)]).includes(code))
  for (const [confirm, re] of [
    [undefined, /要带确认码才能创建：先用 eos chat show/],
    ['00000000', /确认码对不上/],
  ] as const) {
    const c = await createFromProposal({ chats: p.chats, create: p.create, dataDir: p.data, redact: p.redact, id, actor: 'cli', ...(confirm === undefined ? {} : { confirm }), now: () => 300 })
    assert.ok(!c.ok)
    assert.match(c.error, re)
  }
  assert.equal(p.created.length, 0)
  // 另一条提议的确认码对不上这一条。
  const r2 = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' })
  const other = p.chats.taskProposals(r2.chat.id)[0]!.id
  const cross = await p.createTask(id, undefined, 'cli', p.codeOf(other))
  assert.ok(!cross.ok)
  assert.ok((await p.createTask(id)).ok)
})

test('while another process is creating from the same proposal, creating is refused', async () => {
  const p = platform()
  const r = await propose(p, { title: '补测试', repo: p.repo, workflow: 'standard', request: '补测试' })
  const id = p.chats.taskProposals(r.chat.id)[0]!.id
  const held = acquire(join(p.data, 'locks'), `chat-task-${id}`)
  assert.ok(!('heldBy' in held))
  try {
    const c = await p.createTask(id)
    assert.ok(!c.ok)
    assert.match(c.error, /正在被进程 \d+ 创建/)
  } finally {
    held.release()
  }
  assert.equal(p.created.length, 0)
})
