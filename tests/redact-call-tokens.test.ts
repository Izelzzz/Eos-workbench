// 每次调用的临时令牌（Claude Code 的一次性上游令牌、对话 agent 的 MCP 令牌）在 trace、回复、日志里是遮住的。
// 遮蔽按平台的组装方式搭：凭据存储 + knownSecrets + redactText（src/cli.ts 的 redact），执行器外面包 redacting()。
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { openEndpoint } from '../src/chat/mcp.ts'
import { parseMasterKey } from '../src/credentials/key.ts'
import { knownSecrets, MASK, redacting, redactText } from '../src/credentials/redact.ts'
import { Credentials } from '../src/credentials/store.ts'
import { ClaudeCodeExecutor } from '../src/executor/claude-code.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import { FakeAnthropic, stepOf } from './fake-anthropic.ts'

const ROOT = join(import.meta.dirname, '..')
const dirs: string[] = []
const fake = new FakeAnthropic()
const fakeUrl = await fake.start()
after(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  await fake.close()
})
const tmp = () => {
  const d = mkdtempSync(join(ROOT, 'node_modules', '.eos-call-tokens-'))
  dirs.push(d)
  return d
}

/** 和 src/cli.ts 一样的遮蔽：凭据存储里的值、运行时登记的短期凭据、启动时取走的模型 key。 */
const platformRedact = (extra: string[] = []) => {
  const key = parseMasterKey(randomBytes(32).toString('base64'))
  if (key.kind !== 'ok') throw new Error('key')
  const secrets = knownSecrets(new Credentials(join(tmp(), 'eos.db'), key.key), extra)
  return (text: string) => redactText(text, secrets())
}

test('Claude Code 的一次性令牌：agent 把环境打印出来时，实时 trace、回放的 trace、回复里都是遮住的', async () => {
  const root = tmp()
  const ws = join(root, 'ws')
  mkdirSync(ws)
  const real = 'sk-ant-real-key-for-redaction-test'
  const redact = platformRedact([real])
  const ex = redacting(new ClaudeCodeExecutor({ home: join(root, 'data'), modelKey: () => real, target: fakeUrl, env: process.env }), redact)
  let printed = ''
  fake.reply = r => {
    if (stepOf(r) === 0) return [{ tool: 'Bash', input: { command: 'echo "token=$ANTHROPIC_API_KEY"' } }]
    // 模型把工具输出（里面有令牌）原样写进回复
    printed = JSON.stringify(r.body.messages?.at(-1))
    return [{ text: `看到了：${/sk-ant-eos-[0-9a-f]+/.exec(printed)?.[0] ?? '?'}` }]
  }
  const events: TraceEvent[] = []
  try {
    const reply = await ex.send({
      key: 'k/tok',
      spec: { write: 'worktree', cwd: ws, profile: { builtinTools: 'standard', denyTools: [], skills: [], mcp: [], background: false } },
      prompt: '打印环境',
      nonce: 'n1',
      ask: async () => '',
      onEvent: e => events.push(e),
    })
    const token = /sk-ant-eos-[0-9a-f]+/.exec(printed)?.[0]
    assert.ok(token !== undefined, 'agent 确实读到了令牌（否则这个测试什么也没证明）')
    const live = JSON.stringify(events)
    const replayed = JSON.stringify(await ex.traceOf('k/tok', 'n1'))
    for (const [where, text] of [
      ['实时 trace', live],
      ['回放的 trace', replayed],
      ['回复', reply.text],
      ['找回的回复', (await ex.findReply('k/tok', 'n1'))?.text ?? ''],
    ] as const) {
      assert.ok(!text.includes(token), `${where}里有令牌`)
      assert.ok(text.includes(MASK), `${where}里没有遮蔽标记`)
    }
    assert.ok(!live.includes(real))
  } finally {
    await ex.close()
  }
})

test('对话 agent 的 MCP 令牌：端点开着时，平台的遮蔽认得它（单独出现、在请求头里都遮住）', async () => {
  const redact = platformRedact()
  const ep = await openEndpoint({ name: 'eos', tools: [], call: () => ({ ok: true, text: '' }) as never })
  const header = ep.mcp.headers.Authorization!
  const token = header.replace(/^Bearer /, '')
  assert.equal(redact(`令牌是 ${token}`), `令牌是 ${MASK}`)
  assert.ok(!redact(`authorization: ${header}`).includes(token))
  await ep.close()
})
