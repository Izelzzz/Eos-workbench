import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentEnv, replyAfter, sessionIdFor } from '../src/executor/dsh.ts'

const user = (text: string, time: number) => ({ type: 'user/message', time, data: { content: [{ type: 'text', text }] } })
const assistant = (text: string, time: number, usage = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 0 }) =>
  ({ type: 'assistant/message', time, data: { usage, message: { content: text === '' ? [{ type: 'tool-call' }] : [{ type: 'text', text }], source: { model: 'deepseek-flash' } } } })
const end = (time: number) => ({ type: 'turn/end', time })

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
