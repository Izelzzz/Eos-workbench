import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { agentEnv, DshExecutor, replyAfter, replyFromRun, sessionIdFor, traceAfter, turnOutcome } from '../src/executor/dsh.ts'

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
  const created: { cwd?: string; processCwd?: string; model?: string; closed: boolean; resumed: string[] }[] = []
  const createHarness = (o: { cwd?: string; processCwd?: string; model?: string }) => {
    const rec = { cwd: o.cwd, processCwd: o.processCwd, model: o.model, closed: false, resumed: [] as string[] }
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

test('each worktree gets its own dsh process whose workspace is that worktree; release closes only that one', async () => {
  const { created, createHarness } = fakeHarnesses()
  const ex = new DshExecutor({ dshHome: '/data/dsh', dshBin: 'dsh', createHarness })
  const send = (key: string, cwd: string, write: 'none' | 'worktree' = 'worktree') =>
    ex.send({ key, nonce: `${key}/c1`, prompt: '做事', spec: { model: 'deepseek-flash', write, cwd }, ask: async () => '' })
  await send('t1/build', '/data/worktrees/t1')
  await send('t1/review', '/data/worktrees/t1', 'none')
  await send('t2/build', '/data/worktrees/t2')
  assert.deepEqual(created.map(c => [c.cwd, c.processCwd]), [['/data/worktrees/t1', '/data/dsh/process-cwd'], ['/data/worktrees/t2', '/data/dsh/process-cwd']],
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
  const home = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-dshhome-'))
  const dir = join(home, 'sessions', '--slug--', sessionIdFor(key))
  mkdirSync(dir, { recursive: true })
  const lines = [{ type: 'session', version: 4, id: sessionIdFor(key), cwd: workspace }, user('之前的消息', 1)]
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n'))))
  return home
}

test('a session whose recorded workspace is not the task worktree is refused, not resumed; a matching one is resumed', async () => {
  const { created, createHarness } = fakeHarnesses()
  const old = new DshExecutor({ dshHome: homeWithSession('t1/build', '/home/user/Eos-workbench'), dshBin: 'dsh', createHarness })
  const call = (ex: DshExecutor) => ex.send({ key: 't1/build', nonce: 't1/c9', prompt: '继续', spec: { model: 'deepseek-flash', write: 'worktree', cwd: '/data/worktrees/t1' }, ask: async () => '' })
  await assert.rejects(call(old), /可写范围是 \/home\/user\/Eos-workbench，不是任务的 worktree \/data\/worktrees\/t1[\s\S]*请中止这个任务后重新发起/)
  assert.deepEqual(created.flatMap(c => c.resumed), [], 'the unsafe session was never resumed')
  const ok = new DshExecutor({ dshHome: homeWithSession('t1/build', '/data/worktrees/t1'), dshBin: 'dsh', createHarness })
  await call(ok)
  assert.deepEqual(created.at(-1)?.resumed, [sessionIdFor('t1/build')])
})

test('a worktree’s next process starts only after its released process has exited (its session lock is free)', async () => {
  const { created, createHarness } = fakeHarnesses(50)
  const ex = new DshExecutor({ dshHome: '/data/dsh', dshBin: 'dsh', createHarness })
  const send = () => ex.send({ key: 't1/build', nonce: 't1/c1', prompt: '做事', spec: { model: 'deepseek-flash', write: 'worktree', cwd: '/data/worktrees/t1' }, ask: async () => '' })
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
  const ex = new DshExecutor({ dshHome: '/data/dsh', dshBin: 'dsh', createHarness })
  await ex.send({ key: 't1/build', nonce: 't1/c1', prompt: '做事', spec: { model: 'deepseek-flash', write: 'worktree', cwd: '/data/worktrees/t1' }, ask: async () => '' })
  void ex.release('/data/worktrees/t1')
  await ex.close()
  assert.equal(created[0]!.closed, true)
})
