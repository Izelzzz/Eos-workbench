// Claude Code 执行器：能力面的换算、每次工具调用的检查、提问、进程环境、上游的认证，
// 以及真的启动 Claude Code（套着 Landlock，模型接口是本机的假接口）核对 key 隔离、写入范围、工具表、技能、提问、后台作业。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { answer, BUILTIN_TOOLS, ClaudeCodeExecutor, claudeCodeHealth, gate, installFact, processEnv, replyAfter, sessionIdFor, toolsFor, traceAfter, type Entry } from '../src/executor/claude-code.ts'
import { anthropicBaseUrl, Upstream } from '../src/executor/claude-code-upstream.ts'
import type { AgentProfile, AgentSpec } from '../src/executor/types.ts'
import { FakeAnthropic, stepOf, type Block, type Req } from './fake-anthropic.ts'

const ROOT = join(import.meta.dirname, '..')
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(ROOT, 'node_modules', '.eos-claude-code-'))
  dirs.push(d)
  return d
}
const fake = new FakeAnthropic()
const fakeUrl = await fake.start()
after(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  await fake.close()
})

const profile = (p: Partial<AgentProfile> = {}): AgentProfile => ({ builtinTools: 'standard', denyTools: [], skills: [], mcp: [], background: false, ...p })
const NEVER = ['ListAgents', 'SendMessage', 'EnterWorktree', 'ExitWorktree', 'EnterPlanMode', 'ExitPlanMode', 'ToolSearch']

describe('能力面换算成 tools 白名单', () => {
  test('白名单里没有任何角色都不该有的工具', () => {
    for (const t of NEVER) assert.ok(!BUILTIN_TOOLS.includes(t), t)
  })
  test('去掉的工具组整组不给；只读的角色没有写文件的工具；不能起后台作业时没有 Monitor；没有技能时没有 Skill', () => {
    const all = toolsFor(profile({ background: true, skills: [{ name: 's', content: '' }] }), 'worktree')
    assert.ok(['Bash', 'Monitor', 'Write', 'WebFetch', 'Agent', 'Skill', 'CronCreate'].every(t => all.includes(t)))
    const t = toolsFor(profile({ denyTools: ['web', 'subagent', 'bash', 'schedule'] }), 'none')
    for (const x of ['WebFetch', 'WebSearch', 'Agent', 'Workflow', 'TaskStop', 'Bash', 'Monitor', 'CronCreate', 'ScheduleWakeup', 'Write', 'Edit', 'NotebookEdit', 'Skill'])
      assert.ok(!t.includes(x), x)
    assert.deepEqual(t, ['Read', 'Glob', 'Grep', 'AskUserQuestion'])
    assert.deepEqual(toolsFor(profile({ builtinTools: 'none' }), 'worktree'), [])
  })
})

describe('每次工具调用前的检查（PreToolUse）', () => {
  const pre = (tool_name: string, tool_input: unknown = {}) => ({ hook_event_name: 'PreToolUse' as const, tool_name, tool_input, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: '' })
  const denied = async (g: ReturnType<typeof gate>, name: string, input?: unknown) =>
    JSON.stringify(await g(pre(name, input) as never, 'x', { signal: new AbortController().signal })).includes('"deny"')
  test('白名单以外的工具（包括没挂的 MCP 服务）拒绝；挂了的 MCP 服务的工具放行', async () => {
    const g = gate(['Read', 'Bash'], ['eos'], true)
    assert.equal(await denied(g, 'Read'), false)
    assert.equal(await denied(g, 'mcp__eos__list_tasks'), false)
    assert.equal(await denied(g, 'mcp__other__x'), true)
    assert.equal(await denied(g, 'mcp__eosx__y'), true)
    assert.equal(await denied(g, 'ListAgents'), true)
  })
  test('不能起后台作业时拒绝带 run_in_background 的调用', async () => {
    assert.equal(await denied(gate(['Bash'], [], false), 'Bash', { command: 'x', run_in_background: true }), true)
    assert.equal(await denied(gate(['Bash'], [], false), 'Bash', { command: 'x' }), false)
    assert.equal(await denied(gate(['Bash'], [], true), 'Bash', { command: 'x', run_in_background: true }), false)
  })
})

test('提问：AskUserQuestion 的每个问题交给平台，回答写进 answers；别的调用放行', async () => {
  const asked: unknown[] = []
  const can = answer(async q => (asked.push(q), 'blue'))
  const input = { questions: [{ question: '用哪种颜色？', header: '颜色', multiSelect: false, options: [{ label: 'red' }, { label: 'blue' }] }] }
  const r = await can('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 't1' } as never)
  assert.deepEqual(r, { behavior: 'allow', updatedInput: { ...input, answers: { '用哪种颜色？': 'blue' } } })
  assert.deepEqual(asked, [{ id: 't1-0', text: '用哪种颜色？', options: ['red', 'blue'] }])
  assert.equal((await can('Bash', { command: 'ls' }, { signal: new AbortController().signal } as never))?.behavior, 'allow')
})

test('进程环境只有白名单里的变量：平台环境里的 key、令牌都不在；模型 key 的位置是一次性令牌；本机上游不走代理', () => {
  const env = processEnv(
    { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-real', DEEPSEEK_API_KEY: 'sk-ds', EOS_MASTER_KEY: 'm', GITHUB_TOKEN: 'g', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'corp', LC_ALL: 'C' },
    { home: '/d/s', baseUrl: 'http://127.0.0.1:1', token: 'sk-ant-eos-t' },
  )
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-eos-t')
  for (const k of ['DEEPSEEK_API_KEY', 'EOS_MASTER_KEY', 'GITHUB_TOKEN']) assert.equal(env[k], undefined, k)
  assert.ok(!Object.values(env).includes('sk-real'))
  assert.equal(env.HTTPS_PROXY, 'http://proxy')
  assert.equal(env.NO_PROXY, 'corp,127.0.0.1,localhost')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/d/s/.claude')
  assert.equal(env.DISABLE_TELEMETRY, '1')
  assert.equal(env.LC_ALL, 'C')
})

describe('上游', () => {
  test('只认登记过、没撤销的令牌；转发时换上真 key；只转发 /v1/', async () => {
    const up = new Upstream(fakeUrl)
    const url = await up.url()
    const post = (token: string | undefined, path = '/v1/messages') =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { 'x-api-key': token }) },
        body: JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: '上游' }] }),
      })
    const g = up.grant(() => 'sk-real-upstream')
    const before = fake.requests.length
    assert.equal((await post(undefined)).status, 401)
    assert.equal((await post('sk-ant-eos-guess')).status, 401)
    assert.equal((await post(g.token, '/other')).status, 404)
    assert.equal((await post(g.token, '/v1/models')).status, 404, '只转发 /v1/messages')
    assert.equal((await fetch(`${url}/v1/messages`, { headers: { 'x-api-key': g.token } })).status, 405, '只转发 POST')
    const ok = await post(g.token)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /claude-code：上游/)
    assert.deepEqual(
      fake.requests.slice(before).map(r => r.key),
      ['sk-real-upstream'],
      '只有带令牌的那一次到了模型接口，带的是真 key',
    )
    g.revoke()
    assert.equal((await post(g.token)).status, 401, '调用结束后令牌没用了')
    assert.equal(up.active, 0)
    await up.close()
  })
  test('路径先规范化再核对：.. 跳不出 /v1/；模型接口流到一半断开时平台不崩，回复被断开', async () => {
    const broken = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {}\n\n')
      setTimeout(() => res.socket?.destroy(), 50)
    })
    await new Promise<void>(ok => broken.listen(0, '127.0.0.1', ok))
    const port = (broken.address() as { port: number }).port
    const up = new Upstream(`http://127.0.0.1:${port}`)
    const url = await up.url()
    const g = up.grant(() => 'k')
    for (const path of ['/v1/../admin', '/v1/%2e%2e/admin', '/v1/./../x']) {
      assert.equal((await fetch(`${url}${path}`, { method: 'POST', headers: { 'x-api-key': g.token } })).status, 404, path)
    }
    const r = await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': g.token }, body: '{}' })
    assert.equal(r.status, 200)
    await assert.rejects(r.text(), '流断开时回复也断开')
    // 平台进程还在，上游照常服务
    assert.equal((await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'bad' } })).status, 401)
    await up.close()
    broken.closeAllConnections()
    await new Promise(ok => broken.close(ok))
  })
  test('请求体和回复都有上限：超过时拒绝或断开', async () => {
    const big = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('x'.repeat(10_000))
    })
    await new Promise<void>(ok => big.listen(0, '127.0.0.1', ok))
    const up = new Upstream(`http://127.0.0.1:${(big.address() as { port: number }).port}`, { body: 1000, response: 5000 })
    const url = await up.url()
    const g = up.grant(() => 'k')
    assert.equal((await fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': g.token }, body: 'y'.repeat(2000) })).status, 413)
    // 断开可能发生在回复头发出之前或之后：两种情况客户端都拿不到完整的回复
    await assert.rejects(
      fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': g.token }, body: '{}' }).then(r => r.text()),
      '回复超过上限时断开',
    )
    await up.close()
    big.closeAllConnections()
    await new Promise(ok => big.close(ok))
  })
  test('模型接口地址：默认官方；只接受 https 或本机 http，不带用户名和密码', () => {
    assert.equal(anthropicBaseUrl({}), 'https://api.anthropic.com')
    assert.equal(anthropicBaseUrl({ EOS_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9')
    assert.throws(() => anthropicBaseUrl({ EOS_ANTHROPIC_BASE_URL: 'http://example.com' }), /只能是 https/)
    assert.throws(() => anthropicBaseUrl({ EOS_ANTHROPIC_BASE_URL: 'https://u:p@example.com' }), /用户名和密码/)
  })
})

describe('会话日志', () => {
  const at = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString()
  const log: Entry[] = [
    { type: 'user', timestamp: at(0), cwd: '/w', message: { role: 'user', content: '一\n\n<!-- eos:n1 -->' } },
    { type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'x', content: [{ type: 'thinking', thinking: '想' }], stop_reason: null, usage: { input_tokens: 5, output_tokens: 3 } } },
    {
      type: 'assistant',
      timestamp: at(1),
      message: { id: 'm1', model: 'x', content: [{ type: 'tool_use', id: 'tu', name: 'Bash', input: { command: 'ls' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 3 } },
    },
    { type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'a.txt' }] } },
    { type: 'assistant', timestamp: at(3), isSidechain: true, message: { id: 'side', content: [{ type: 'text', text: '子 agent' }], stop_reason: 'end_turn', usage: { input_tokens: 100 } } },
    {
      type: 'assistant',
      timestamp: at(4),
      message: { id: 'm2', model: 'x', content: [{ type: 'text', text: '好了' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 4 } },
    },
    { type: 'user', timestamp: at(5), message: { role: 'user', content: '二\n\n<!-- eos:n2 -->' } },
    { type: 'assistant', timestamp: at(6), message: { id: 'm3', content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 1 } } },
  ]
  test('找回：按 nonce 切出范围，最后一条是 end_turn 才算完成；用量按 message.id 去重，不算子 agent', () => {
    assert.deepEqual(replyAfter(log, 'n1', 's'), { sessionId: 's', text: '好了', usage: { input: 12, output: 5, cacheRead: 4, cacheWrite: 0 }, ms: 4000, model: 'x' })
    assert.equal(replyAfter(log, 'n2', 's'), undefined, '停在工具调用上：没做完，要重发')
    assert.equal(replyAfter(log, 'n9', 's'), undefined)
  })
  test('trace：一个 message.id 是一步，先 model 再 tool_start，工具结果是 tool_end', () => {
    assert.deepEqual(
      traceAfter(log, 'n1').map(e => e.kind + ('step' in e ? e.step : '')),
      ['call_start', 'step_start1', 'model1', 'tool_start1', 'tool_end', 'step_end1', 'step_start2', 'model2', 'step_end2'],
    )
    const m = traceAfter(log, 'n1').find(e => e.kind === 'model')
    assert.deepEqual(m?.kind === 'model' && [m.reasoning, m.toolCalls], ['想', [{ id: 'tu', name: 'Bash', args: '{"command":"ls"}' }]])
  })
})

test('自检：认得出装好的 SDK 和原生的 Claude Code；没有这个平台的原生包时算没装好', () => {
  assert.deepEqual(installFact(ROOT), { version: `SDK ${JSON.parse(readFileSync(join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version}` })
  assert.deepEqual(installFact(ROOT, 'plan9', 'x64'), { missing: true })
  assert.deepEqual(installFact('/'), { missing: true }, '没有装 SDK')
})

test('自检：没准备好的只提示、只在 eos doctor 里列出，不拦下平台启动；接口地址写错时拦下', () => {
  const h = claudeCodeHealth({ install: { missing: true }, landlock: 'unusable', modelKey: { source: 'missing' }, credentialsUsable: true })
  assert.ok(h.items.every(i => i.status === 'warn' && i.doctorOnly === true))
  assert.equal(h.sandboxed, true, 'Landlock 用不了时拒绝调用，agent 不会在沙箱外运行')
  const ok = claudeCodeHealth({ install: { version: 'SDK 1' }, landlock: 'full', modelKey: { source: 'env' }, credentialsUsable: true, baseUrl: { kind: 'invalid', error: '错' } })
  assert.deepEqual(
    ok.items.map(i => i.status),
    ['ok', 'ok', 'ok', 'fail'],
  )
})

// ---- 真的启动 Claude Code ----

const REAL_KEY = 'sk-ant-real-platform-key'
const spec = (cwd: string, p: Partial<AgentProfile> = {}, write: AgentSpec['write'] = 'worktree'): AgentSpec => ({ write, cwd, profile: profile(p) })
/** 剧本：这一轮第 n 次请求时回复 steps[n]，走完以后回复「完成」。 */
const script =
  (...steps: ((r: Req) => Block[])[]) =>
  (r: Req): Block[] =>
    (steps[stepOf(r)] ?? (() => [{ text: '完成' }]))(r)
const lastToolResult = (r: Req): string => {
  const m = r.body.messages?.at(-1)
  return Array.isArray(m?.content)
    ? (m.content as { type: string; content?: unknown }[])
        .filter(c => c.type === 'tool_result')
        .map(c => JSON.stringify(c.content))
        .join('')
    : ''
}
const make = () => {
  const root = tmp()
  const ws = join(root, 'ws')
  mkdirSync(ws)
  const ex = new ClaudeCodeExecutor({ home: join(root, 'data'), modelKey: () => REAL_KEY, target: fakeUrl, env: process.env })
  return { root, ws, ex }
}

describe('真的启动 Claude Code', () => {
  test('key 不进 Claude Code 和 agent：agent 的命令读到的只有一次性令牌；发到模型接口的是真 key；调用结束后令牌作废', async () => {
    const { ws, ex } = make()
    const from = fake.requests.length
    fake.reply = script(() => [{ tool: 'Bash', input: { command: `{ echo "$ANTHROPIC_API_KEY"; tr '\\0' '\\n' < /proc/$PPID/environ; env; } > ${ws}/seen.txt 2>&1; echo ok` } }])
    await ex.send({ key: 'k/key', spec: spec(ws), prompt: '读环境', nonce: 'n1', ask: async () => '' })
    const seen = readFileSync(join(ws, 'seen.txt'), 'utf8')
    assert.ok(!seen.includes(REAL_KEY), 'agent 读不到真 key')
    const token = /^sk-ant-eos-[0-9a-f]+$/m.exec(seen)?.[0]
    assert.ok(token !== undefined, 'agent 能看到的是一次性令牌')
    assert.deepEqual([...new Set(fake.requests.slice(from).map(r => r.key))], [REAL_KEY])
    // agent 拿着令牌在调用结束后直接连上游：没用
    const base = /^ANTHROPIC_BASE_URL=(.+)$/m.exec(seen)?.[1]
    assert.ok(base !== undefined)
    const r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 401)
    await ex.close()
  })

  test('MCP 的令牌和环境不在 Claude Code 的命令行和环境里（本机任何用户都能读命令行）；平台给的 MCP 照常能用', async () => {
    const { ws, ex } = make()
    let result = ''
    fake.reply = script(
      () => [{ tool: 'Bash', input: { command: `{ tr '\\0' ' ' < /proc/$PPID/cmdline; tr '\\0' '\\n' < /proc/$PPID/environ; } > ${ws}/cc.txt 2>&1; echo ok` } }],
      () => [{ tool: 'mcp__probe__get_codeword', input: {} }],
      r => ((result = lastToolResult(r)), [{ text: '完成' }]),
    )
    const mcp = [
      { name: 'probe', command: process.execPath, args: [join(ROOT, 'tests', 'fixtures', 'codeword-mcp.mjs')], env: { CODEWORD: 'MCP-ENV-SECRET-7Q' } },
      { name: 'remote', url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer MCP-HEADER-SECRET-9K' } },
    ]
    await ex.send({ key: 'k/mcp', spec: spec(ws, { mcp }), prompt: '读命令行', nonce: 'n1', ask: async () => '' })
    const seen = readFileSync(join(ws, 'cc.txt'), 'utf8')
    assert.ok(seen.includes('claude'), '读到了 Claude Code 进程的命令行')
    assert.doesNotMatch(seen, /MCP-HEADER-SECRET-9K|MCP-ENV-SECRET-7Q/)
    assert.match(result, /MCP-ENV-SECRET-7Q/, 'MCP 服务拿到了平台给的环境，工具能用')
    await ex.close()
  })

  test('写入范围：可写的角色只能写 worktree、自己的会话目录和 /tmp；只读的角色连 worktree 也写不了', async () => {
    const { root, ws, ex } = make()
    const cmd = `echo x > ${ws}/in.txt; echo x > ${root}/out.txt; echo x > ${ROOT}/eos-cc-escape.txt; echo done`
    fake.reply = script(() => [{ tool: 'Bash', input: { command: cmd } }])
    await ex.send({ key: 'k/w', spec: spec(ws), prompt: '写', nonce: 'n1', ask: async () => '' })
    assert.equal(existsSync(join(ws, 'in.txt')), true)
    assert.equal(existsSync(join(root, 'out.txt')), false)
    assert.equal(existsSync(join(ROOT, 'eos-cc-escape.txt')), false)
    rmSync(join(ws, 'in.txt'))
    await ex.send({ key: 'k/r', spec: spec(ws, {}, 'none'), prompt: '写', nonce: 'n1', ask: async () => '' })
    assert.equal(existsSync(join(ws, 'in.txt')), false)
    await ex.close()
  })

  test('工具表：去掉的工具组不在发给模型的工具表里，强行调用被拒绝', async () => {
    const { ws, ex } = make()
    const from = fake.requests.length
    let result = ''
    fake.reply = script(
      () => [{ tool: 'Bash', input: { command: 'echo hi' } }],
      r => ((result = lastToolResult(r)), [{ text: '完成' }]),
    )
    await ex.send({ key: 'k/t', spec: spec(ws, { denyTools: ['bash', 'web', 'subagent'] }), prompt: '跑命令', nonce: 'n1', ask: async () => '' })
    const tools = (fake.requests[from]?.body.tools ?? []).map(t => t.name)
    for (const t of ['Bash', 'Monitor', 'WebFetch', 'Agent', ...NEVER]) assert.ok(!tools.includes(t), t)
    assert.ok(tools.includes('Read'))
    assert.match(result, /No such tool|not available|平台没有给/)
    await ex.close()
  })

  test('技能：平台给的技能能用，看不到别的', async () => {
    const { ws, ex } = make()
    const from = fake.requests.length
    let result = ''
    fake.reply = script(
      () => [{ tool: 'Skill', input: { skill: 'eos:codeword' } }],
      r => ((result = JSON.stringify(r.body.messages)), [{ text: '完成' }]),
    )
    await ex.send({
      key: 'k/s',
      spec: spec(ws, { skills: [{ name: 'codeword', content: '---\nname: codeword\ndescription: 问暗号时用\n---\n暗号是 SK-7Q2W。\n' }] }),
      prompt: '用技能',
      nonce: 'n1',
      ask: async () => '',
    })
    assert.match(result, /SK-7Q2W/)
    const sent = JSON.stringify(fake.requests.slice(from).map(r => r.body))
    assert.match(sent, /问暗号时用/)
    assert.doesNotMatch(sent, /claude-api|update-config/)
    await ex.close()
  })

  test('提问：agent 的问题交给平台，回答回到 agent；不能起后台作业时后台命令被拒绝', async () => {
    const { ws, ex } = make()
    let result = ''
    fake.reply = script(
      () => [
        {
          tool: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: '用哪种颜色？',
                header: '颜色',
                multiSelect: false,
                options: [
                  { label: 'red', description: '红' },
                  { label: 'blue', description: '蓝' },
                ],
              },
            ],
          },
        },
      ],
      r => ((result = lastToolResult(r)), [{ tool: 'Bash', input: { command: `touch ${ws}/bg.txt`, run_in_background: true } }]),
      r => ((result += lastToolResult(r)), [{ text: '完成' }]),
    )
    const asked: string[] = []
    await ex.send({ key: 'k/q', spec: spec(ws), prompt: '问我', nonce: 'n1', ask: async q => (asked.push(q.text), 'blue') })
    assert.deepEqual(asked, ['用哪种颜色？'])
    assert.match(result, /blue/)
    assert.match(result, /不能起后台作业/)
    assert.equal(existsSync(join(ws, 'bg.txt')), false)
    await ex.close()
  })

  test('平台崩溃留下的同一个会话的进程，在下一次调用前结束；别的会话的不碰', async () => {
    const { ws, ex } = make()
    const mine = spawn('sh', ['-c', 'sleep 60', 'sh', sessionIdFor('k/orphan')], { stdio: 'ignore' })
    const other = spawn('sh', ['-c', 'sleep 60', 'sh', sessionIdFor('k/someone-else')], { stdio: 'ignore' })
    const exited = new Promise(ok => mine.on('exit', ok))
    fake.reply = r => [{ text: `claude-code：${stepOf(r)}` }]
    await ex.send({ key: 'k/orphan', spec: spec(ws), prompt: '一', nonce: 'n1', ask: async () => '' })
    await exited
    assert.equal(mine.signalCode, 'SIGKILL')
    assert.equal(other.exitCode, null, '别的会话的进程还在')
    other.kill()
    await ex.close()
  })

  test('release 中止这个 worktree 里正在跑的调用，等 Claude Code 进程结束后才返回；经过链接的同一个 worktree 照常续接', async () => {
    const { root, ws, ex } = make()
    let started!: () => void
    const running = new Promise<void>(ok => (started = ok))
    fake.reply = script(() => (started(), [{ tool: 'Bash', input: { command: 'node -e "setTimeout(() => {}, 30000)" eos-release-probe' } }]))
    const call = ex.send({ key: 'k/rel', spec: spec(ws), prompt: '一', nonce: 'n1', ask: async () => '' })
    await running
    await new Promise(ok => setTimeout(ok, 1500))
    const t0 = Date.now()
    await ex.release(ws)
    await assert.rejects(call, /中止/)
    assert.ok(Date.now() - t0 < 15_000)
    // Claude Code 进程已经退出；它起的命令在它退出时被结束，几秒内消失
    const alive = async () => new Promise(ok => spawn('pgrep', ['-f', 'eos-release-probe']).on('exit', code => ok(code === 0)))
    for (let i = 0; i < 50 && (await alive()); i++) await new Promise(ok => setTimeout(ok, 100))
    assert.equal(await alive(), false, 'agent 起的命令也不在了')
    // 同一个 worktree 经过一个链接给出：续接，不当成别的目录
    symlinkSync(ws, join(root, 'link'))
    fake.reply = r => [{ text: `claude-code：${stepOf(r)}` }]
    await ex.send({ key: 'k/rel', spec: spec(join(root, 'link')), prompt: '二', nonce: 'n2', ask: async () => '' })
    await ex.close()
  })

  test('不续接工作目录不一样的会话；Landlock 用不了时拒绝调用', async () => {
    const { ws, ex } = make()
    fake.reply = r => [{ text: `claude-code：${r.body.model}` }]
    const a = await ex.send({ key: 'k/c', spec: spec(ws), prompt: '一', nonce: 'n1', ask: async () => '' })
    assert.equal(a.sessionId, sessionIdFor('k/c'))
    assert.equal(a.text, 'claude-code：claude-sonnet-5-5', '没写 model 时用执行器的默认模型')
    const other = join(ws, '..', 'other')
    mkdirSync(other)
    await assert.rejects(ex.send({ key: 'k/c', spec: spec(other), prompt: '二', nonce: 'n2', ask: async () => '' }), /不再续接/)
    await ex.close()
    const off = new ClaudeCodeExecutor({ home: join(ws, '..', 'data2'), modelKey: () => REAL_KEY, target: fakeUrl, landlock: () => 'unusable' })
    await assert.rejects(off.send({ key: 'k/x', spec: spec(ws), prompt: '一', nonce: 'n1', ask: async () => '' }), /Landlock 用不了/)
    await off.close()
  })
})
