import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseMasterKey, type MasterKey } from '../src/credentials/key.ts'
import { MODEL_KEY_ENV, resolveModelKey, takeModelKeyEnv } from '../src/credentials/model-key.ts'
import { base64Forms, knownSecrets, MASK, redactDeep, redacting, redactText, rememberSecret } from '../src/credentials/redact.ts'
import { Credentials } from '../src/credentials/store.ts'
import { LOCAL_OWNER } from '../src/credentials/types.ts'
import type { Executor } from '../src/executor/types.ts'
import type { TraceEvent } from '../src/trace/types.ts'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const db = () => {
  const d = mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-redact-'))
  dirs.push(d)
  return join(d, 'eos.db')
}
const newKey = (): MasterKey => {
  const s = parseMasterKey(randomBytes(32).toString('base64'))
  if (s.kind !== 'ok') throw new Error('key')
  return s.key
}

const KEY = 'sk-0123456789abcdef'
const TOKEN = 'ghp_abcdefghijklmnop'

test('redactText replaces every occurrence of every known value with ***', () => {
  assert.equal(redactText(`a ${KEY} b ${KEY}\nAuthorization: Bearer ${TOKEN}`, [KEY, TOKEN]), `a ${MASK} b ${MASK}\nAuthorization: Bearer ${MASK}`)
  assert.equal(redactText('nothing here', [KEY]), 'nothing here')
})

test('redactText skips values shorter than 8 characters, so common short strings are not mangled', () => {
  assert.equal(redactText('the test passed', ['test', 'abc1234']), 'the test passed')
  assert.equal(redactText('x abcd1234 y', ['abcd1234']), `x ${MASK} y`)
})

test('redactText also masks the JSON-escaped form of a multi-line value (a PEM inside a JSON string)', () => {
  const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----'
  assert.equal(redactText(JSON.stringify({ out: `k=${pem}` }), [pem]), JSON.stringify({ out: 'k=***' }))
  assert.equal(redactText(`k=${pem}`, [pem]), 'k=***')
})

test('redactText masks a token inside a base64 Git auth header (x-access-token:<token>)', () => {
  const header = `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`
  const out = redactText(header, [TOKEN])
  assert.ok(out.includes(MASK), out)
  for (const f of base64Forms(TOKEN)) assert.ok(!out.includes(f), out)
  assert.ok(out.startsWith('Authorization: Basic eC1hY2Nlc3MtdG9rZW46'), '前缀 x-access-token: 的编码原样保留')
})

test('base64 masking works at every byte alignment and with any prefix or suffix, leaving at most one token-dependent character at each end', () => {
  const token = 'ghp_' + randomBytes(18).toString('hex')
  for (const prefix of ['', 'a', 'ab', 'x:', 'x-access-token:', 'oauth2:', 'user@example.com:']) {
    for (const suffix of ['', 'z', '\n', ':tail']) {
      const encoded = Buffer.from(prefix + token + suffix).toString('base64')
      // 按位算：第 i 个字符占 [6i, 6i+6) 位，和令牌占的 [8p, 8(p+n)) 位有重叠就是和令牌有关的字符。
      const from = Buffer.byteLength(prefix) * 8
      const to = from + Buffer.byteLength(token) * 8
      const differs = [...encoded].map((_, i) => 6 * i < to && 6 * i + 6 > from)
      const out = redactText(encoded, [token])
      const at = out.indexOf(MASK)
      assert.ok(at >= 0, `${prefix}|${suffix}: ${out}`)
      const head = out.slice(0, at)
      const tail = out.slice(at + MASK.length)
      assert.ok(encoded.startsWith(head) && encoded.endsWith(tail), out)
      const leftHead = differs.slice(0, head.length).filter(Boolean).length
      const leftTail = differs.slice(encoded.length - tail.length).filter(Boolean).length
      assert.ok(leftHead <= 1 && leftTail <= 1, `${JSON.stringify(prefix)}|${JSON.stringify(suffix)}: 两端各留下 ${leftHead}、${leftTail} 个和令牌有关的字符：${out}`)
    }
  }
})

test('base64Forms gives the exact middle of the encoding for each byte alignment; ordinary base64 text is untouched', () => {
  // 'abcd1234' 本身、'x' + 它、'xy' + 它的 base64 分别是 YWJjZDEyMzQ=、eGFiY2QxMjM0、eHlhYmNkMTIzNA==；每种只取完全由 'abcd1234' 决定的字符。
  assert.deepEqual(base64Forms('abcd1234'), ['YWJjZDEyMz', 'FiY2QxMjM0', 'hYmNkMTIzN'])
  for (const [prefix, form] of [['', 'YWJjZDEyMz'], ['x', 'FiY2QxMjM0'], ['xy', 'hYmNkMTIzN']] as const) assert.ok(Buffer.from(`${prefix}abcd1234`).toString('base64').includes(form))
  const plain = `payload ${Buffer.from('hello world').toString('base64')}`
  assert.equal(redactText(plain, [TOKEN]), plain)
})

test('redactText replaces the longer value first when one value contains another', () => {
  assert.equal(redactText(`${KEY}-extended`, [KEY, `${KEY}-extended`]), MASK)
})

test('redactDeep masks strings anywhere in a trace event or check result and keeps other fields', () => {
  const e: TraceEvent = { kind: 'tool_end', t: 5, id: 'x', output: `env: DEEPSEEK_API_KEY=${KEY}`, isError: false }
  assert.deepEqual(redactDeep(e, s => redactText(s, [KEY])), { kind: 'tool_end', t: 5, id: 'x', output: `env: DEEPSEEK_API_KEY=${MASK}`, isError: false })
  const results = [{ check: { kind: 'run' as const, run: ['npm', 'test'] }, passed: false, detail: `token ${TOKEN} leaked` }]
  assert.equal(redactDeep(results, s => redactText(s, [TOKEN]))[0]!.detail, `token ${MASK} leaked`)
})

test('redacting executor masks the reply, live trace events, replayed trace, agent questions and errors', async () => {
  const seen: { events: TraceEvent[]; questions: string[] } = { events: [], questions: [] }
  const inner: Executor = {
    send: async p => {
      p.onEvent?.({ kind: 'tool_start', t: 1, step: 1, id: 'a', name: 'shell', args: `echo ${KEY}` })
      await p.ask({ id: 'q', text: `用 ${KEY} 吗？` }, new AbortController().signal)
      return { sessionId: 's', text: `key is ${KEY}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1 }
    },
    findReply: async () => ({ sessionId: 's', text: KEY, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1 }),
    traceOf: async () => [{ kind: 'tool_end', t: 2, id: 'a', output: KEY, isError: false }],
    release: async () => {},
    close: async () => {},
  }
  const ex = redacting(inner, s => redactText(s, [KEY]))
  const reply = await ex.send({
    key: 'k', nonce: 'n', prompt: 'p', spec: { model: 'm', write: 'none', cwd: '/w', profile: { denyTools: [], skills: [], mcp: [], background: false } } as never,
    ask: async q => { seen.questions.push(q.text); return 'ok' }, onEvent: e => seen.events.push(e),
  })
  assert.equal(reply.text, `key is ${MASK}`)
  assert.deepEqual(seen.questions, [`用 ${MASK} 吗？`])
  assert.equal((seen.events[0] as { args: string }).args, `echo ${MASK}`)
  assert.equal((await ex.findReply('k', 'n'))?.text, MASK)
  assert.deepEqual(await ex.traceOf('k', 'n'), [{ kind: 'tool_end', t: 2, id: 'a', output: MASK, isError: false }])

  const failing = redacting({ ...inner, send: async () => { throw new Error(`401 for key ${KEY}`) } }, s => redactText(s, [KEY]))
  await assert.rejects(failing.send({ key: 'k', nonce: 'n', prompt: 'p', spec: {} as never, ask: async () => '' }), (e: Error) => !e.message.includes(KEY) && !(e.stack ?? '').includes(KEY))
})

test('knownSecrets: all decryptable credentials plus extra values; picks up changes made after startup', () => {
  const c = new Credentials(db(), newKey())
  c.put(LOCAL_OWNER, 'deepseek', 'api-key', KEY)
  let t = 0
  const secrets = knownSecrets(c, ['env-model-key-value'], () => t)
  assert.deepEqual([...secrets()].sort(), [KEY, 'env-model-key-value'].sort())
  c.put(LOCAL_OWNER, 'github.com', 'token', TOKEN)
  assert.deepEqual([...secrets()].sort(), [KEY, 'env-model-key-value'].sort(), '一秒内不重新查')
  t = 1000
  assert.deepEqual([...secrets()].sort(), [KEY, TOKEN, 'env-model-key-value'].sort())
  c.delete(LOCAL_OWNER, 'deepseek')
  t = 2000
  assert.deepEqual([...secrets()].sort(), [TOKEN, 'env-model-key-value'].sort())
})

test('knownSecrets keeps the last known values when the credential list cannot be read, and reports the error once', () => {
  const c = new Credentials(db(), newKey())
  c.put(LOCAL_OWNER, 'deepseek', 'api-key', KEY)
  let t = 0
  const errors: unknown[] = []
  const secrets = knownSecrets(c, ['extra-value-123'], () => t, e => errors.push(e))
  assert.deepEqual([...secrets()].sort(), [KEY, 'extra-value-123'].sort())
  c.close()
  t = 5000
  assert.deepEqual([...secrets()].sort(), [KEY, 'extra-value-123'].sort())
  t = 10000
  secrets()
  assert.equal(errors.length, 1, '读不了时报一次错，不重复刷屏')
})

test('model key: the credential wins over the env var; env is the fallback; an unreadable credential is an error, not a silent fallback', () => {
  const key = newKey()
  const path = db()
  const c = new Credentials(path, key)
  assert.deepEqual(resolveModelKey(c, undefined), { source: 'missing' })
  assert.deepEqual(resolveModelKey(c, 'from-env'), { source: 'env', value: 'from-env' })
  assert.deepEqual(resolveModelKey(undefined, 'from-env'), { source: 'env', value: 'from-env' })
  c.put(LOCAL_OWNER, 'deepseek', 'api-key', KEY)
  assert.deepEqual(resolveModelKey(c, 'from-env'), { source: 'credentials', value: KEY })
  const otherKey = new Credentials(path, newKey())
  const r = resolveModelKey(otherKey, 'from-env')
  assert.equal(r.source, 'error')
  assert.match((r as { error: string }).error, /另一个主密钥/)
  assert.equal(resolveModelKey(new Credentials(path, undefined), 'from-env').source, 'error')
})

test('takeModelKeyEnv reads the env key and removes it from the environment; blank counts as unset', () => {
  const env: NodeJS.ProcessEnv = { [MODEL_KEY_ENV]: ' k-from-env ', PATH: '/bin' }
  assert.equal(takeModelKeyEnv(env), 'k-from-env')
  assert.deepEqual(env, { PATH: '/bin' })
  assert.equal(takeModelKeyEnv({ [MODEL_KEY_ENV]: '  ' }), undefined)
})

test('knownSecrets：JSON 凭据里的机密字段（例如 GitHub App 的私钥）单独出现也遮住，slug、App id 不遮；运行时登记的短期令牌也遮住', () => {
  const c = new Credentials(db(), newKey())
  // 测试运行时现场生成，不把私钥写进仓库。
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.deepEqual(c.put(LOCAL_OWNER, 'github-app.github.com', 'github-app', JSON.stringify({ appId: '4242424242', slug: 'eos-workbench-app', privateKey: pem })), { ok: true })
  const secrets = knownSecrets(c, [])
  assert.equal(redactText(`私钥：${pem}`, secrets()), `私钥：${MASK}`)
  assert.equal(redactText('安装 eos-workbench-app（App 4242424242）', secrets()), '安装 eos-workbench-app（App 4242424242）', 'slug 和 App id 不是机密，不遮')
  const minted = `ghs_${randomBytes(12).toString('hex')}`
  rememberSecret(minted)
  assert.equal(redactText(`令牌 ${minted} 和认证头 ${Buffer.from(`x-access-token:${minted}`).toString('base64')}`, secrets()).includes(minted.slice(4)), false)
})
