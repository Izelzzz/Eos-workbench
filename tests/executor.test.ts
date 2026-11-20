import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentEnv, replyAfter, sessionIdFor, traceAfter, turnOutcome } from '../src/executor/dsh.ts'

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

test('a turn that hit the output limit at some step but finished still counts, as dsh itself treats it', () => {
  const log = [user('m <!-- eos:n1 -->', 1), assistant('写到上限后接着写完的回复', 2), end(3, 'max-tokens')]
  assert.equal(replyAfter(log, 'n1', 's')?.text, '写到上限后接着写完的回复')
})

test('the live call and the log claim judge how a turn ended the same way', () => {
  assert.deepEqual(turnOutcome('completed'), { ok: true })
  assert.deepEqual(turnOutcome('max-tokens'), { ok: true })
  assert.deepEqual(turnOutcome('interrupted', '我先看一下目录'), { ok: false, error: '这一轮没有正常完成（被打断）：我先看一下目录' })
  assert.deepEqual(turnOutcome('error'), { ok: false, error: '这一轮没有正常完成（出错）' })
  assert.deepEqual(turnOutcome('aborted'), { ok: false, error: '这一轮没有正常完成（被中止）' })
  assert.deepEqual(turnOutcome('blocked'), { ok: false, error: '这一轮没有正常完成（被拦下）' })
  assert.deepEqual(turnOutcome(null), { ok: false, error: '这一轮没有正常完成（结束原因为 未知）' })
})
