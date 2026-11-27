// 跨执行器的接口测试：同一套用例对每个登记的执行器各跑一遍（不调模型：dsh 用假的 dsh 进程，它像 dsh 一样把会话写进会话日志；
// Claude Code 跑真的 Claude Code，模型接口换成本机的假接口 tests/fake-anthropic.ts）。
// 新登记一个执行器（src/executor/registry.ts 的 EXECUTORS）时，要在 FACTORIES 里给它一个不调模型的构造，否则第一个用例失败。
// 后面是注册表本身的用例：按 executor 分派、找回时只交给调用用的执行器、没登记的名字报错。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { ClaudeCodeExecutor } from '../src/executor/claude-code.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import { checkExecutor, EXECUTORS, Executors, healthOf, modelKeySpecs } from '../src/executor/registry.ts'
import type { AgentSpec, Capabilities, Executor, ExecutorContext, ExecutorKind } from '../src/executor/types.ts'
import { needsOf } from '../src/executor/types.ts'
import type { TraceEvent } from '../src/trace/types.ts'
import { FakeAnthropic } from './fake-anthropic.ts'
import { MemoryExecutor } from './memory-executor.ts'

const ROOT = join(import.meta.dirname, '..')
const dirs: string[] = []
/** Claude Code 用真的 Claude Code 进程（套着 Landlock），模型接口换成本机的假接口。 */
const fakeAnthropic = new FakeAnthropic()
const fakeAnthropicUrl = await fakeAnthropic.start()
after(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  await fakeAnthropic.close()
})
const tmp = () => {
  const d = mkdtempSync(join(ROOT, 'node_modules', '.eos-contract-'))
  dirs.push(d)
  return d
}

type Notify = (n: { method: string; params: { sessionId: string; event: unknown } }) => void

/**
 * 假的 dsh 进程：每轮像 dsh 一样把会话头、用户消息、回复和 turn/end 写进 <dshHome>/sessions/<目录>/<会话 id>/ 下的会话日志，
 * 所以 findReply、traceOf 走的是 DshExecutor 真正读日志的那条路。以 / 开头的是设置命令（例如权限档位），不进日志。
 * 日志在进程之间保留：release 关掉进程后，新进程续接的是同一份日志，和真的 dsh 一样。
 */
const loggingHarness = (dshHome: string) => {
  const logs = new Map<string, object[]>()
  return (o: { cwd?: string; model?: string }) => {
    const session = (id: string) => {
      const dir = join(dshHome, 'sessions', '--slug--', id)
      const lines = logs.get(id) ?? [{ type: 'session', version: 4, id, cwd: o.cwd }]
      logs.set(id, lines)
      return {
        id,
        setWorkingDirectory: async () => {},
        run: async (input: string, opts?: { onNotification?: Notify }) => {
          if (input.startsWith('/')) return { finishReason: 'stop', finalResponse: '', events: [] }
          const text = `dsh：${input.split('\n')[0]}`
          let t = lines.length
          const turn = [
            { type: 'turn/start', time: ++t },
            { type: 'step/start', time: ++t, data: { step: 1 } },
            { type: 'user/message', time: ++t, data: { content: [{ type: 'text', text: input }] } },
            {
              type: 'assistant/message',
              time: ++t,
              data: { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, message: { content: [{ type: 'text', text }], source: { model: o.model } } },
            },
            { type: 'step/end', time: ++t, data: { step: 1 } },
            { type: 'turn/end', time: ++t, data: { reason: { kind: 'completed' } } },
          ]
          for (const event of turn) opts?.onNotification?.({ method: 'session.event', params: { sessionId: id, event } })
          lines.push(...turn)
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.map(l => JSON.stringify(l)).join('\n'))))
          return { finishReason: 'stop', finalResponse: text, events: turn }
        },
      }
    }
    return { session, resumeSession: async (id: string) => session(id), close: async () => {} } as never
  }
}

/** 每个登记的执行器一个不调模型的构造。 */
const FACTORIES: Record<string, () => Executor> = {
  dsh: () => {
    const dshHome = tmp()
    return new DshExecutor({ dshHome, dshBin: 'dsh', modelKey: () => 'sk-contract-key', createHarness: loggingHarness(dshHome) })
  },
  'claude-code': () => new ClaudeCodeExecutor({ home: tmp(), modelKey: () => 'sk-contract-key', target: fakeAnthropicUrl, env: process.env }),
}

test('每个登记的执行器都有接口测试的构造', () => {
  assert.deepEqual(
    EXECUTORS.map(k => k.name),
    Object.keys(FACTORIES),
  )
})

const spec = (cwd: string): AgentSpec => ({ model: 'm', write: 'worktree', cwd, profile: { builtinTools: 'standard', denyTools: [], skills: [], mcp: [], background: false } })
const ask = async () => ''

/** 每个执行器都要做到的。 */
const contract = (make: () => Executor) => {
  test('send 返回回复；同一个 key 是同一个会话，不同的 key 是不同的会话', async () => {
    const ex = make()
    const cwd = tmp()
    const events: TraceEvent[] = []
    const a = await ex.send({ key: 't1/build', spec: spec(cwd), prompt: '第一句', nonce: 'n1', ask, onEvent: e => events.push(e) })
    const b = await ex.send({ key: 't1/build', spec: spec(cwd), prompt: '第二句', nonce: 'n2', ask })
    const c = await ex.send({ key: 't1/review', spec: spec(cwd), prompt: '第三句', nonce: 'n1', ask })
    assert.match(a.text, /第一句/)
    assert.equal(a.sessionId, b.sessionId)
    assert.notEqual(a.sessionId, c.sessionId)
    for (const u of Object.values(a.usage)) assert.equal(typeof u, 'number')
    assert.ok(events.length > 0, '调用过程中有事件')
    await ex.close()
  })

  test('findReply 按 key 和 nonce 找回已完成的回复；没有时是 undefined', async () => {
    const ex = make()
    const cwd = tmp()
    const sent = await ex.send({ key: 't2/build', spec: spec(cwd), prompt: '做事', nonce: 'n1', ask })
    const found = await ex.findReply('t2/build', 'n1')
    assert.equal(found?.text, sent.text)
    assert.equal(found?.sessionId, sent.sessionId)
    assert.equal(await ex.findReply('t2/build', 'n9'), undefined)
    assert.equal(await ex.findReply('t2/other', 'n1'), undefined)
    await ex.close()
  })

  test('traceOf 回放一次调用，从 call_start 开始；没有时是空的', async () => {
    const ex = make()
    const cwd = tmp()
    await ex.send({ key: 't3/build', spec: spec(cwd), prompt: '做事', nonce: 'n1', ask })
    const trace = await ex.traceOf('t3/build', 'n1')
    assert.equal(trace[0]?.kind, 'call_start')
    assert.ok(trace.some(e => e.kind === 'model'))
    assert.deepEqual(await ex.traceOf('t3/build', 'n9'), [])
    await ex.close()
  })

  test('release 之后同一个 key 照常可用，还是原来的会话', async () => {
    const ex = make()
    const cwd = tmp()
    const a = await ex.send({ key: 't4/build', spec: spec(cwd), prompt: '一', nonce: 'n1', ask })
    await ex.release(cwd)
    const b = await ex.send({ key: 't4/build', spec: spec(cwd), prompt: '二', nonce: 'n2', ask })
    assert.equal(a.sessionId, b.sessionId)
    // 只要求找得回最近一次调用：runner 只在重做这一次调用时找回复（dsh 里之后又开始了一轮的旧调用找不回）
    assert.equal((await ex.findReply('t4/build', 'n2'))?.text, b.text)
    await ex.close()
  })
}

for (const [name, make] of Object.entries({ ...FACTORIES, memory: () => new MemoryExecutor() })) describe(`执行器接口：${name}`, () => contract(make))

// ---- 注册表 ----

const ctx: ExecutorContext = { root: ROOT, dataDir: '/nonexistent', env: {}, modelKey: () => ({ source: 'missing' }), credentialsUsable: true }
const ctxFor = () => ctx
/** 什么都做得到的能力面；测试里按需改掉几项。 */
const ALL: Capabilities = {
  toolGroups: { web: 'removable', subagent: 'removable', bash: 'removable', schedule: 'removable', todo: 'removable', goal: 'removable' },
  noBuiltinTools: true,
  noBackground: true,
  httpMcp: true,
  stdioMcp: true,
  skills: true,
}
const kind = (name: string, made: MemoryExecutor[], o: { fails?: boolean; sandboxed?: boolean; capabilities?: Partial<Capabilities> } = {}): ExecutorKind => ({
  name,
  capabilities: { ...ALL, ...o.capabilities },
  modelKey: { credential: name, env: `${name.toUpperCase()}_API_KEY`, label: `${name} key` },
  create: () => {
    if (o.fails) throw new Error(`${name} 没装好`)
    const ex = new MemoryExecutor(name)
    made.push(ex)
    return ex
  },
  health: () => ({ items: [{ name, status: 'ok', detail: '在' }], sandboxed: o.sandboxed ?? true }),
})

describe('执行器接口：注册表（两个假执行器）', () => contract(() => new Executors(ctxFor, [kind('a', []), kind('b', [])])))

test('注册表按 spec.executor 分派，不写时用第一个（默认）；同一个工作流的角色可以用不同执行器', async () => {
  const made: MemoryExecutor[] = []
  const reg = new Executors(ctxFor, [kind('a', made), kind('b', made)])
  assert.equal(made.length, 0, '用到时才建')
  const viaDefault = await reg.send({ key: 't/dev', spec: spec('/w'), prompt: '默认', nonce: 'n1', ask })
  const viaB = await reg.send({ key: 't/review', spec: { ...spec('/w'), executor: 'b' }, prompt: '指定', nonce: 'n1', ask })
  assert.match(viaDefault.text, /^a：/)
  assert.match(viaB.text, /^b：/)
  assert.deepEqual(
    made.map(m => [...m.sessions.keys()]),
    [['t/dev'], ['t/review']],
  )
  // 找回时按调用用的执行器交给它；不写名字时是默认执行器
  assert.equal((await reg.findReply('t/review', 'n1', 'b'))?.text, viaB.text)
  assert.equal((await reg.traceOf('t/review', 'n1', 'b'))[0]?.kind, 'call_start')
  assert.equal(await reg.findReply('t/review', 'n1'), undefined, '默认执行器里没有这个会话')
  await reg.release('/w')
  assert.deepEqual(
    made.map(m => m.released),
    [['/w'], ['/w']],
  )
  await reg.close()
  assert.ok(made.every(m => m.closed))
})

test('两个执行器里有同名的会话和 nonce 时，找回走调用用的那个执行器，不会认错', async () => {
  const made: MemoryExecutor[] = []
  const reg = new Executors(ctxFor, [kind('a', made), kind('b', made)])
  const inA = await reg.send({ key: 't/x', spec: spec('/w'), prompt: '甲', nonce: 'n', ask })
  const inB = await reg.send({ key: 't/x', spec: { ...spec('/w'), executor: 'b' }, prompt: '乙', nonce: 'n', ask })
  assert.equal((await reg.findReply('t/x', 'n', 'b'))?.text, inB.text)
  assert.equal((await reg.findReply('t/x', 'n'))?.text, inA.text)
  assert.match(JSON.stringify(await reg.traceOf('t/x', 'n', 'b')), /乙/)
  assert.doesNotMatch(JSON.stringify(await reg.traceOf('t/x', 'n', 'b')), /甲/)
})

test('注册表：没登记的名字报错并列出可用的；找回不会去建没用到的执行器，建不起来的执行器报出原因', async () => {
  const made: MemoryExecutor[] = []
  const reg = new Executors(ctxFor, [kind('a', made), kind('broken', made, { fails: true }), kind('c', made)])
  const plain = needsOf({ builtinTools: 'standard', denyTools: [], mcp: [], background: true, skills: [] })
  assert.equal(checkExecutor('a', plain, [kind('a', []), kind('broken', []), kind('c', [])]), undefined)
  assert.equal(checkExecutor('zzz', plain, [kind('a', []), kind('broken', []), kind('c', [])]), '没有名为「zzz」的执行器（可用的：a、broken、c）')
  await assert.rejects(reg.send({ key: 'k', spec: { ...spec('/w'), executor: 'zzz' }, prompt: 'p', nonce: 'n', ask }), /没有名为「zzz」的执行器/)
  await reg.send({ key: 'k', spec: spec('/w'), prompt: 'p', nonce: 'n', ask })
  assert.equal((await reg.findReply('k', 'n'))?.sessionId, 'a-1')
  assert.deepEqual(
    made.map(m => m.name),
    ['a'],
    '只建了用到的执行器',
  )
  await assert.rejects(reg.send({ key: 'k2', spec: { ...spec('/w'), executor: 'broken' }, prompt: 'p', nonce: 'n', ask }), /broken 没装好/)
  await assert.rejects(reg.findReply('k2', 'n', 'broken'), /broken 没装好/, '建不起来不当成"没有回复"（否则会重发）')
  assert.throws(() => new Executors(ctxFor, []), /没有登记任何执行器/)
  assert.throws(() => new Executors(ctxFor, [kind('a', []), kind('a', [])]), /名字重复/)
})

test('自检按登记的顺序问每个执行器', () => {
  assert.deepEqual(
    healthOf(ctxFor, [kind('a', []), kind('b', [], { sandboxed: false })]).map(h => [h.name, h.health.items[0]!.name, h.health.sandboxed]),
    [
      ['a', 'a', true],
      ['b', 'b', false],
    ],
  )
})

test('dsh 登记的描述建出的执行器用数据目录下的 dsh home', () => {
  const dataDir = tmp()
  const ex = EXECUTORS.find(k => k.name === 'dsh')!.create({ ...ctx, dataDir })
  assert.ok(ex instanceof DshExecutor)
  assert.equal(ex.processCwd, join(dataDir, 'dsh', 'eos-process-cwd'))
})

test('执行器做不到的能力面：建任务时的核对和 send 都报出原因；本来就没有的工具组算去掉了', async () => {
  const limited = kind('lite', [], {
    capabilities: { toolGroups: { ...ALL.toolGroups, web: 'fixed', schedule: 'absent' }, noBuiltinTools: false, noBackground: false, httpMcp: false, stdioMcp: false, skills: false },
  })
  const kinds = [kind('a', []), limited]
  const role = (o: Partial<Parameters<typeof needsOf>[0]>) => needsOf({ builtinTools: 'standard', denyTools: [], mcp: [], background: true, skills: [], ...o })
  assert.equal(checkExecutor('lite', role({ denyTools: ['schedule'] }), kinds), undefined, '本来就没有：等于已经去掉')
  assert.equal(checkExecutor('lite', role({ denyTools: ['web', 'schedule'] }), kinds), '执行器「lite」去不掉工具组 web')
  assert.equal(checkExecutor('lite', role({ background: false }), kinds), '执行器「lite」关不掉后台作业（可写的角色不能起后台作业）')
  assert.equal(checkExecutor('lite', role({ skills: [{ name: 's', content: 'x' }] }), kinds), '执行器「lite」不支持技能')
  assert.equal(checkExecutor('lite', role({ mcp: [{ name: 'm', command: 'node', args: [], env: {} }] }), kinds), '执行器「lite」接不了 stdio 的 MCP 服务')
  assert.equal(
    checkExecutor('lite', needsOf({ builtinTools: 'none', denyTools: [], mcp: [{ name: 'p', url: 'http://127.0.0.1/mcp', headers: {} }], background: false, skills: [] }), kinds),
    '执行器「lite」关不掉自带的工具；执行器「lite」接不了平台的 HTTP MCP 端点',
  )
  assert.equal(checkExecutor(undefined, role({ denyTools: ['web'] }), kinds), undefined, '不写名字时核对默认执行器')
  // send 时注册表也拦：不交给执行器
  const made: MemoryExecutor[] = []
  const reg = new Executors(ctxFor, [kind('a', made), kind('lite', made, { capabilities: { toolGroups: { ...ALL.toolGroups, web: 'fixed' } } })])
  const deny = { ...spec('/w'), executor: 'lite', profile: { ...spec('/w').profile, denyTools: ['web' as const] } }
  await assert.rejects(reg.send({ key: 'k', spec: deny, prompt: 'p', nonce: 'n', ask }), /执行器「lite」去不掉工具组 web/)
  assert.deepEqual(made, [], '没有建出执行器，也没有发出去')
})

test('每个登记的执行器都声明了能力面和模型 key；平台按声明取走的环境变量不重复', () => {
  for (const k of EXECUTORS) {
    assert.deepEqual(Object.keys(k.capabilities.toolGroups).sort(), ['bash', 'goal', 'schedule', 'subagent', 'todo', 'web'], k.name)
    assert.ok(k.modelKey.credential !== '' && /^[A-Z][A-Z0-9_]*$/.test(k.modelKey.env), k.name)
  }
  assert.deepEqual(
    modelKeySpecs([kind('a', []), { ...kind('b', []), modelKey: kind('a', []).modelKey }]).map(s => s.env),
    ['A_API_KEY'],
  )
})

test('每个执行器的上下文按它自己声明的模型 key 给（ctxFor 收到的是那种执行器）', () => {
  const seen: string[] = []
  healthOf(k => (seen.push(k.modelKey.credential), ctx), [kind('a', []), kind('b', [])])
  assert.deepEqual(seen, ['a', 'b'])
})

test('dsh 声明的模型 key 就是现有部署用的那条：凭据 deepseek、环境变量 DEEPSEEK_API_KEY，不需要迁移', () => {
  const dsh = EXECUTORS.find(k => k.name === 'dsh')!
  assert.deepEqual(dsh.modelKey, { credential: 'deepseek', env: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key' })
  assert.deepEqual(
    modelKeySpecs().map(s => s.env),
    ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY'],
  )
})

test('Claude Code 声明的模型 key：凭据 anthropic、环境变量 ANTHROPIC_API_KEY', () => {
  assert.deepEqual(EXECUTORS.find(k => k.name === 'claude-code')!.modelKey, { credential: 'anthropic', env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' })
})
