import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { parse as parseYaml } from 'yaml'
import { agentEnv, ALWAYS_DISABLED, DshExecutor, GROUP_ROWS, parseSessionLog, patchRows, profileHash, replyAfter, replyFromRun, sessionIdFor, traceAfter, turnOutcome } from '../src/executor/dsh.ts'
import type { AgentProfile } from '../src/executor/types.ts'

const user = (text: string, time: number) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }] } })
const assistant = (text: string, time: number, usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 0 }) =>
  ({ type: 'assistant/message', time, data: { usage, message: { content: text === '' ? [{ type: 'tool-call' }] : [{ type: 'text', text }], source: { model: 'deepseek-flash' } } } })
const end = (time: number, kind = 'completed') => ({ type: 'turn/end', time, data: { reason: { kind } } })

test('session ids are stable per key and look like dsh ids', () => {
  assert.equal(sessionIdFor('t1/build'), sessionIdFor('t1/build'))
  assert.notEqual(sessionIdFor('t1/build'), sessionIdFor('t1/review'))
  assert.match(sessionIdFor('x'), /^session-[0-9a-f]{32}$/)
})

test('finds the last text reply of the completed turn after the tagged message, summing usage', () => {
  const log = [
    user('旧消息 <!-- eos:n0 -->', 1), assistant('旧回复', 2), end(3),
    user('新消息 <!-- eos:n1 -->', 10), assistant('', 11), assistant('最终回复', 15), end(16),
  ]
  assert.deepEqual(replyAfter(log, 'n1', 's'), {
    sessionId: 's', text: '最终回复', ms: 6, model: 'deepseek-flash',
    usage: { input: 10, output: 4, cacheRead: 200, cacheWrite: 0 },
  })
})

test('an unfinished turn or an unknown nonce means the call must be sent again', () => {
  assert.equal(replyAfter([user('m <!-- eos:n1 -->', 1), assistant('写到一半', 2)], 'n1', 's'), undefined)
  assert.equal(replyAfter([user('m <!-- eos:n1 -->', 1), assistant('x', 2), end(3)], 'n2', 's'), undefined)
})

test('a resent message is matched by its latest copy', () => {
  const log = [user('m <!-- eos:n1 -->', 1), assistant('第一次', 2), user('m <!-- eos:n1 -->', 5), assistant('第二次', 6), end(7)]
  assert.equal(replyAfter(log, 'n1', 's')?.text, '第二次')
})

test('host-injected git config is dropped as a whole, other variables are kept', () => {
  const env = agentEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'url.x.insteadOf', GIT_CONFIG_VALUE_0: 'y', GIT_EDITOR: 'true', PATH: '/bin', DEEPSEEK_API_KEY: 'k' })
  assert.deepEqual(env, { GIT_EDITOR: 'true', PATH: '/bin', DEEPSEEK_API_KEY: 'k' })
})

test('a call that spans several turns is claimed only after its last turn, with all its text and usage', () => {
  const start = { type: 'turn/start', time: 0 }
  const log = [
    user('m <!-- eos:n1 -->', 1), start, assistant('等后台命令跑完', 2), end(3),
    start, assistant('命令跑完了，这是最终结果', 8), end(9),
    user('下一次调用 <!-- eos:n2 -->', 20), assistant('别的', 21), end(22),
  ]
  const r = replyAfter(log, 'n1', 's')
  assert.equal(r?.text, '命令跑完了，这是最终结果')
  assert.equal(r?.usage.input, 10)
  assert.equal(r?.ms, 8)
  assert.equal(replyAfter(log.slice(0, 6), 'n1', 's'), undefined, 'second turn started but not finished')
})

test('trace replay starts at the turn, keeping the first step that dsh opens before inserting the message', () => {
  const log = [
    user('旧 <!-- eos:n0 -->', 1), end(2),
    { type: 'turn/start', time: 10 }, { type: 'step/start', time: 11, data: { step: 1 } }, user('m <!-- eos:n1 -->', 12),
    assistant('', 15), { type: 'tool/call', time: 16, data: { step: 1, callId: 'k1', name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', time: 18, data: { message: { toolCallId: 'k1', isError: false, content: [{ type: 'text', text: 'a.js' }] } } },
    { type: 'step/end', time: 19, data: { step: 1 } }, end(20),
  ]
  assert.deepEqual(traceAfter(log, 'n1').map(e => [e.kind, e.t]), [['call_start', 10], ['step_start', 11], ['model', 15], ['tool_start', 16], ['tool_end', 18], ['step_end', 19]])
})

test('a turn that ended any other way than completed is not claimed, even if it said something midway', () => {
  for (const kind of ['interrupted', 'error', 'aborted', 'blocked']) {
    const log = [user('m <!-- eos:n1 -->', 1), assistant('我先看一下目录结构。', 2), end(3, kind)]
    assert.equal(replyAfter(log, 'n1', 's'), undefined, kind)
  }
  // 续接时 dsh 补写 interrupted 收尾，之后重发同一条消息并正常完成：认领重发的那一轮。
  const resent = [user('m <!-- eos:n1 -->', 1), assistant('半截', 2), end(3, 'interrupted'), user('m <!-- eos:n1 -->', 5), assistant('完整的回复', 6), end(7)]
  assert.equal(replyAfter(resent, 'n1', 's')?.text, '完整的回复')
})

test('a turn cut off at the output limit is not claimed: its last step never ran its tools', () => {
  const log = [user('m <!-- eos:n1 -->', 1), assistant('我来写测试文件', 2), end(3, 'max-tokens')]
  assert.equal(replyAfter(log, 'n1', 's'), undefined)
})

test('the live call and the log claim judge how a turn ended the same way', () => {
  assert.deepEqual(turnOutcome('completed'), { ok: true })
  assert.deepEqual(turnOutcome('max-tokens'), { ok: false, error: '这一轮没有正常完成（输出达到上限被截断，这一步的工具调用没有执行）' })
  assert.deepEqual(turnOutcome('interrupted', '我先看一下目录'), { ok: false, error: '这一轮没有正常完成（被打断）：我先看一下目录' })
  assert.deepEqual(turnOutcome('error'), { ok: false, error: '这一轮没有正常完成（出错）' })
  assert.deepEqual(turnOutcome('aborted'), { ok: false, error: '这一轮没有正常完成（被中止）' })
  assert.deepEqual(turnOutcome('blocked'), { ok: false, error: '这一轮没有正常完成（被拦下）' })
  assert.deepEqual(turnOutcome(null), { ok: false, error: '这一轮没有正常完成（结束原因为 未知）' })
})

test('a live call returns its reply only when the last turn completed, trusting the turn over the SDK status', () => {
  const run = (kind: string, finishReason: string) => ({
    finishReason, finalResponse: '最终回复',
    events: [user('m', 1), assistant('最终回复', 2), end(3, kind)] as never,
  })
  assert.deepEqual(replyFromRun(run('completed', 'completed'), 's', 7), {
    sessionId: 's', text: '最终回复', ms: 7, model: 'deepseek-flash', usage: { input: 5, output: 2, cacheRead: 100, cacheWrite: 0 },
  })
  // sdk profile 的 maxTokensAsSuccess 会把截断报告成成功：以 turn/end 为准，仍然失败。
  assert.throws(() => replyFromRun(run('max-tokens', 'completed'), 's', 7), /输出达到上限被截断/)
  assert.throws(() => replyFromRun(run('interrupted', 'interrupted'), 's', 7), /被打断/)
  assert.throws(() => replyFromRun({ finishReason: 'error', finalResponse: '', events: [] }, 's', 7), /出错/)
})

/** 假的 dsh 进程：记下启动参数，会话的每轮都正常完成。 */
const fakeHarnesses = (closeMs = 0) => {
  const created: { cwd?: string; processCwd?: string; model?: string; patches?: string[]; closed: boolean; resumed: string[] }[] = []
  const createHarness = (o: { cwd?: string; processCwd?: string; model?: string; patches?: string[] }) => {
    const rec = { cwd: o.cwd, processCwd: o.processCwd, model: o.model, patches: o.patches, closed: false, resumed: [] as string[] }
    created.push(rec)
    const session = (id: string) => ({
      id,
      setWorkingDirectory: async () => {},
      run: async (input: string) => ({ finishReason: 'stop', finalResponse: input.startsWith('/') ? '' : `回复：${o.cwd}`,
        events: [{ type: 'turn/end', time: 1, data: { reason: { kind: 'completed' } } }] }),
    })
    const resumeSession = async (id: string) => {
      rec.resumed.push(id)
      return session(id)
    }
    const close = async () => {
      await new Promise(r => setTimeout(r, closeMs))
      rec.closed = true
    }
    return { session, resumeSession, close } as never
  }
  return { created, createHarness }
}

/** 测试用的 dsh home：执行器会往里面写能力面的补丁和技能目录；跑完一起删掉。 */
const homes: string[] = []
const tmpHome = () => {
  const home = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-dshhome-'))
  homes.push(home)
  return home
}
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
})

/** 不限制任何东西的能力面：不涉及工具组、技能和 MCP 的用例用它。 */
const bare: AgentProfile = { denyTools: [], skills: [], mcp: [], background: true }

test('each worktree gets its own dsh process whose workspace is that worktree; release closes only that one', async () => {
  const { created, createHarness } = fakeHarnesses()
  const home = tmpHome()
  const ex = new DshExecutor({ dshHome: home, dshBin: 'dsh', createHarness })
  const send = (key: string, cwd: string, write: 'none' | 'worktree' = 'worktree') =>
    ex.send({ key, nonce: `${key}/c1`, prompt: '做事', spec: { model: 'deepseek-flash', write, cwd, profile: bare }, ask: async () => '' })
  await send('t1/build', '/data/worktrees/t1')
  await send('t1/review', '/data/worktrees/t1', 'none')
  await send('t2/build', '/data/worktrees/t2')
  assert.deepEqual(created.map(c => [c.cwd, c.processCwd]), [['/data/worktrees/t1', join(home, 'process-cwd')], ['/data/worktrees/t2', join(home, 'process-cwd')]],
    'the session workspace (write root) is the task worktree; the dsh process itself runs in a platform directory, not in the worktree (no .env from the repo)')
  await ex.release('/data/worktrees/t1')
  assert.deepEqual(created.map(c => c.closed), [true, false])
  await send('t1/build', '/data/worktrees/t1')
  assert.equal(created.length, 3, 'a later call for that worktree starts a fresh process')
  await ex.close()
  assert.ok(created.every(c => c.closed))
})

/** 一个真实的 dsh home，里面有一个会话日志，会话头记着它的工作区。 */
const homeWithSession = (key: string, workspace: string) => {
  const home = tmpHome()
  const dir = join(home, 'sessions', '--slug--', sessionIdFor(key))
  mkdirSync(dir, { recursive: true })
  const lines = [{ type: 'session', version: 4, id: sessionIdFor(key), cwd: workspace }, user('之前的消息', 1)]
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n'))))
  return home
}

test('a session whose recorded workspace is not the task worktree is refused, not resumed; a matching one is resumed', async () => {
  const { created, createHarness } = fakeHarnesses()
  const old = new DshExecutor({ dshHome: homeWithSession('t1/build', '/home/user/Eos-workbench'), dshBin: 'dsh', createHarness })
  const call = (ex: DshExecutor) => ex.send({ key: 't1/build', nonce: 't1/c9', prompt: '继续', spec: { model: 'deepseek-flash', write: 'worktree', cwd: '/data/worktrees/t1', profile: bare }, ask: async () => '' })
  await assert.rejects(call(old), /可写范围是 \/home\/user\/Eos-workbench，不是任务的 worktree \/data\/worktrees\/t1[\s\S]*请中止这个任务后重新发起/)
  assert.deepEqual(created.flatMap(c => c.resumed), [], 'the unsafe session was never resumed')
  const ok = new DshExecutor({ dshHome: homeWithSession('t1/build', '/data/worktrees/t1'), dshBin: 'dsh', createHarness })
  await call(ok)
  assert.deepEqual(created.at(-1)?.resumed, [sessionIdFor('t1/build')])
})

test('a worktree’s next process starts only after its released process has exited (its session lock is free)', async () => {
  const { created, createHarness } = fakeHarnesses(50)
  const ex = new DshExecutor({ dshHome: tmpHome(), dshBin: 'dsh', createHarness })
  const send = () => ex.send({ key: 't1/build', nonce: 't1/c1', prompt: '做事', spec: { model: 'deepseek-flash', write: 'worktree', cwd: '/data/worktrees/t1', profile: bare }, ask: async () => '' })
  await send()
  const releasing = ex.release('/data/worktrees/t1')
  const again = send()
  await again
  assert.equal(created.length, 2)
  assert.equal(created[0]!.closed, true, 'the old process had exited before the new one was created')
  await releasing
  await ex.close()
})

test('close waits for processes that are still being released', async () => {
  const { created, createHarness } = fakeHarnesses(50)
  const ex = new DshExecutor({ dshHome: tmpHome(), dshBin: 'dsh', createHarness })
  await ex.send({ key: 't1/build', nonce: 't1/c1', prompt: '做事', spec: { model: 'deepseek-flash', write: 'worktree', cwd: '/data/worktrees/t1', profile: bare }, ask: async () => '' })
  void ex.release('/data/worktrees/t1')
  await ex.close()
  assert.equal(created[0]!.closed, true)
})

/** 从 dsh 进程实际拿到的补丁文件里读回配置。 */
const rowsOf = (patch: string) => parseYaml(readFileSync(patch, 'utf8')) as { id?: string; disabled?: boolean; config?: Record<string, any>; insert?: { id: string; name: string; config: Record<string, any> }[] }[]
const rowById = (patch: string, id: string) => rowsOf(patch).find(r => r.id === id)
const disabledIn = (patch: string) => rowsOf(patch).filter(r => r.disabled === true).map(r => r.id)
const insertedIn = (patch: string) => rowsOf(patch).find(r => r.insert !== undefined)?.insert ?? []

const skillOf = (name: string, body: string) => ({ name, content: `---\nname: ${name}\ndescription: ${name} 用的技能\n---\n${body}\n` })

/** 一次调用，返回这次新起的 dsh 进程拿到的补丁文件路径。 */
const launch = async (ex: DshExecutor, created: { patches?: string[] }[], key: string, profile: AgentProfile, cwd = '/data/worktrees/t1') => {
  await ex.send({ key, nonce: `${key}/c1`, prompt: '做事', ask: async () => '', spec: { model: 'deepseek-flash', write: 'none', cwd, profile } })
  return created.at(-1)!.patches![0]!
}

test('the profile patch disables the denied groups’ rows, and always the plugin manager and the bundled office skills', async () => {
  const { created, createHarness } = fakeHarnesses()
  const ex = new DshExecutor({ dshHome: tmpHome(), dshBin: 'dsh', createHarness })
  const patch = await launch(ex, created, 't1/plan', { denyTools: ['bash', 'web'], skills: [], mcp: [], background: true })
  assert.deepEqual(disabledIn(patch).sort(), [...ALWAYS_DISABLED, ...GROUP_ROWS.bash, ...GROUP_ROWS.web].sort())
  // 没限制的组一行都不关：工具组之间互不牵连。
  for (const g of ['subagent', 'schedule', 'todo', 'goal'] as const) {
    for (const row of GROUP_ROWS[g]) assert.ok(!disabledIn(patch).includes(row), `${row} 不该被关掉`)
  }
})

test('an agent only sees its own skills: the skills dir holds exactly their SKILL.md, and dsh’s default skill roots are off', async () => {
  const { created, createHarness } = fakeHarnesses()
  const ex = new DshExecutor({ dshHome: tmpHome(), dshBin: 'dsh', createHarness })
  const skills = [skillOf('write-changes', '写改动说明的步骤'), skillOf('review', '评审要点')]
  const profile: AgentProfile = { denyTools: [], skills, mcp: [], background: true }
  const patch = await launch(ex, created, 't1/plan', profile)
  const skillsDir = join(ex.profileDir(profile), 'skills')
  assert.deepEqual(rowById(patch, 'skill-filesystem')!.config, { includeDefaultRoots: false, customSkillDirs: [skillsDir] },
    'includeDefaultRoots off means the repo’s and the user’s skills are invisible; only the template’s skills dir is read')
  assert.deepEqual(readdirSync(skillsDir).sort(), ['review', 'write-changes'])
  for (const s of skills) assert.equal(readFileSync(join(skillsDir, s.name, 'SKILL.md'), 'utf8'), s.content, '快照内容原样写出，不做改写')
})

test('a role with no skills still gets an empty skills dir, not dsh’s defaults', async () => {
  const { created, createHarness } = fakeHarnesses()
  const ex = new DshExecutor({ dshHome: tmpHome(), dshBin: 'dsh', createHarness })
  const profile: AgentProfile = { denyTools: [], skills: [], mcp: [], background: true }
  const patch = await launch(ex, created, 't1/plan', profile)
  const skillsDir = join(ex.profileDir(profile), 'skills')
  assert.deepEqual(rowById(patch, 'skill-filesystem')!.config, { includeDefaultRoots: false, customSkillDirs: [skillsDir] })
  assert.deepEqual(readdirSync(skillsDir), [])
  assert.deepEqual(insertedIn(patch), [], '没有 MCP 服务时不插入 mcp-client 行')
})

test('each MCP server becomes an inserted mcp-client row whose child runs in a platform dir, not in the worktree', async () => {
  const { created, createHarness } = fakeHarnesses()
  const home = tmpHome()
  const ex = new DshExecutor({ dshHome: home, dshBin: 'dsh', createHarness })
  const mcp = [{ name: 'docs', command: 'node', args: ['server.mjs'], env: { DOCS_ROOT: '/srv/docs' } }]
  const inserted = insertedIn(await launch(ex, created, 't1/plan', { denyTools: [], skills: [], mcp, background: true }))
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0]!.name, '@deepseek-ai/dsh-mcp-client')
  assert.deepEqual(inserted[0]!.config, {
    transport: 'stdio', serverName: 'docs', command: 'node', args: ['server.mjs'], env: { DOCS_ROOT: '/srv/docs' },
    cwd: join(home, 'mcp-cwd'), toolCallTimeoutMs: 60_000, closeTimeoutMs: 5_000, expandTemplates: false, failOnStartupError: true,
  })
  assert.notEqual(inserted[0]!.config.cwd, '/data/worktrees/t1', 'the MCP child must not run in the task worktree')
  assert.ok(existsSync(join(home, 'mcp-cwd')), 'that directory exists before dsh spawns the server')
})

test('the same worktree runs one dsh process per capability profile, and roles with the same profile share one', async () => {
  const { created, createHarness } = fakeHarnesses()
  const ex = new DshExecutor({ dshHome: tmpHome(), dshBin: 'dsh', createHarness })
  const plan: AgentProfile = { denyTools: ['bash'], skills: [skillOf('review', '评审要点')], mcp: [], background: true }
  await launch(ex, created, 't1/plan', plan)
  // 同一个能力面（另建的等值对象）：共用进程，不再起新的。
  await launch(ex, created, 't1/plan2', { denyTools: ['bash'], skills: [skillOf('review', '评审要点')], mcp: [], background: true })
  assert.equal(created.length, 1, '相同能力面共用一个 dsh 进程')
  // 工具组不同、技能内容不同、MCP 不同：各起一个进程。
  await launch(ex, created, 't1/build', { ...plan, denyTools: [] })
  await launch(ex, created, 't1/doc', { ...plan, skills: [skillOf('review', '改过的评审要点')] })
  await launch(ex, created, 't1/mcp', { ...plan, mcp: [{ name: 'docs', command: 'node', args: [], env: {} }], background: true })
  assert.equal(created.length, 4)
  assert.equal(new Set(created.map(c => c.patches![0])).size, 4, '每个能力面有自己的补丁文件')
  await ex.close()
})

test('the profile fingerprint ignores skill order but not skill content', () => {
  const a = skillOf('a', 'A'), b = skillOf('b', 'B')
  assert.equal(profileHash({ denyTools: ['web', 'bash'], skills: [a, b], mcp: [], background: true }), profileHash({ denyTools: ['bash', 'web'], skills: [b, a], mcp: [], background: true }))
  assert.notEqual(profileHash({ denyTools: [], skills: [a], mcp: [], background: true }), profileHash({ denyTools: [], skills: [{ ...a, content: '改了' }], mcp: [], background: true }))
})

test('patch rows carry user values as data, never as interpolated yaml', () => {
  const rows = patchRows({ denyTools: [], skills: [], mcp: [{ name: 'docs', command: 'node', args: ['--eval', 'x: 1\n- y'], env: { A: '*' } }], background: true }, '/p/skills', '/p/mcp-cwd')
  const insert = (rows as { insert?: { config: Record<string, any> }[] }[]).find(r => r.insert !== undefined)!.insert!
  assert.deepEqual(insert[0]!.config.args, ['--eval', 'x: 1\n- y'], '像 yaml 的值仍然是一个字符串')
  assert.equal(insert[0]!.config.expandTemplates, false)
})

test('writable roles cannot start background jobs: job tools are removed and bash refuses run_in_background (Izelzzz/Eos-workbench#28)', () => {
  const rowsFor = (background: boolean, denyTools: ('bash' | 'web')[] = []) => patchRows({ denyTools, skills: [], mcp: [], background }, '/p/skills', '/p/mcp-cwd') as { id?: string; disabled?: boolean; config?: Record<string, unknown> }[]
  const writer = rowsFor(false)
  assert.ok(writer.some(r => r.id === 'tool-jobs' && r.disabled === true))
  assert.ok(writer.some(r => r.id === 'tool-workflow' && r.disabled === true), 'the workflow tool has its own background mode')
  assert.deepEqual(writer.find(r => r.id === 'tool-bash')?.config, { enableRunInBackground: false, promoteOnTimeout: false })
  const reader = rowsFor(true)
  assert.ok(!reader.some(r => r.id === 'tool-jobs'), 'read-only roles keep background jobs: the sandbox already stops them writing')
  assert.ok(!reader.some(r => r.id === 'tool-bash'))
  assert.ok(!rowsFor(false, ['bash']).some(r => r.id === 'tool-bash' && r.config !== undefined), 'no config for a bash row that is disabled anyway')
  assert.notEqual(profileHash({ denyTools: [], skills: [], mcp: [], background: true }), profileHash({ denyTools: [], skills: [], mcp: [], background: false }))
})

/** dsh 的写法：每次追加一个 zstd 帧，每帧是若干行 JSON。 */
const frames = (...groups: object[][]) => Buffer.concat(groups.map(g => zstdCompressSync(Buffer.from(g.map(l => `${JSON.stringify(l)}\n`).join('')))))

test('a session log written as several zstd frames is read whole, not just its first frame', () => {
  const head = { type: 'session', version: 4, id: 's', cwd: '/w' }
  const buf = frames([head], [user('做事 <!-- eos:n1 -->', 1)], [assistant('做完了', 2), end(3)])
  assert.deepEqual(parseSessionLog(buf)?.map(e => e.type), ['session', 'user/message', 'assistant/message', 'turn/end'])
  assert.equal(replyAfter(parseSessionLog(buf)!, 'n1', 's')?.text, '做完了', 'the reply in the last frame is found')
})

test('a last frame cut off mid-write is dropped and the frames before it are kept; so is a broken last line', () => {
  const whole = frames([{ type: 'session', version: 4 }], [user('a', 1)], [assistant('b', 2), end(3)])
  for (let cut = 1; cut < 40; cut++) {
    const events = parseSessionLog(whole.subarray(0, whole.length - cut))
    assert.deepEqual(events?.map(e => e.type), ['session', 'user/message'], `cut ${cut} bytes`)
  }
  const skippable = Buffer.alloc(12)
  skippable.writeUInt32LE(0x184d2a50, 0)
  skippable.writeUInt32LE(4, 4)
  assert.deepEqual(parseSessionLog(Buffer.concat([frames([user('a', 1)]), skippable, frames([user('b', 2)])]))?.length, 2, 'skippable frames are skipped')
  const brokenLine = zstdCompressSync(Buffer.from(`${JSON.stringify(user('a', 1))}\n{"type":"assis`))
  assert.deepEqual(parseSessionLog(brokenLine)?.map(e => e.type), ['user/message'])
  assert.equal(parseSessionLog(Buffer.from('not zstd')), undefined)
  assert.equal(parseSessionLog(Buffer.alloc(0)), undefined)
})

test('after a crash, a reply that dsh wrote in a later frame is claimed instead of resending the call', async () => {
  const home = tmpHome()
  const dir = join(home, 'sessions', '--slug--', sessionIdFor('t1/build'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frames([{ type: 'session', version: 4, id: sessionIdFor('t1/build'), cwd: '/w' }], [user('做事 <!-- eos:t1/c2 -->', 1)], [assistant('做完了', 2), end(3)]))
  const ex = new DshExecutor({ dshHome: home, dshBin: 'dsh' })
  assert.equal((await ex.findReply('t1/build', 't1/c2'))?.text, '做完了')
})
