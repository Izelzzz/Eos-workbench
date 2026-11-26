// 不调模型的假执行器：像一个真的 agent 那样，用标准 MCP（Streamable HTTP）连 spec.profile.mcp 里的端点，按剧本调工具、给回复。
// 用来证明功能代码只认 Executor 接口（不经过 dsh 也能跑通）；第 18 项「执行器解耦」的测试也可以用它。
// - 剧本按会话（key）看到这句话和这个会话之前的话，决定调哪些工具、最后回复什么；
// - 剧本里的工具名不在 MCP 端点上时，当作执行器的自带工具，只发 trace 事件不执行（用来测试「调了别的工具就作废」）；
// - 同一个 key 是同一个会话：history 按 key 记下收到的每句话。
import type { AgentSpec, AskHandler, Executor, HttpMcp, Reply } from '../src/executor/types.ts'
import { isHttpMcp } from '../src/executor/types.ts'
import type { TraceEvent } from '../src/trace/types.ts'

export type McpStep = { tool: string; args: Record<string, unknown> }
/** results：这一轮之前各步工具的返回（文字）。返回下一步要调的工具，或者最后的回复。 */
export type McpScript = (p: { key: string; prompt: string; history: string[]; results: string[]; spec: AgentSpec }) => McpStep | { reply: string }

/** 最小的 MCP 客户端：initialize → tools/list → tools/call。 */
export class McpClient {
  private id = 0
  constructor(private readonly server: HttpMcp) {}
  async rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(this.server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...this.server.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, ...(params === undefined ? {} : { params }) }),
    })
    if (!res.ok) throw new Error(`MCP ${method}：HTTP ${res.status}`)
    const body = (await res.json()) as { result?: Record<string, unknown>; error?: { message: string } }
    if (body.error !== undefined) throw new Error(`MCP ${method}：${body.error.message}`)
    return body.result!
  }
  async tools(): Promise<string[]> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '1' } })
    return ((await this.rpc('tools/list')).tools as { name: string }[]).map(t => t.name)
  }
  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.rpc('tools/call', { name, arguments: args })
    return { text: (r.content as { text: string }[]).map(c => c.text).join(''), isError: r.isError === true }
  }
}

export class McpExecutor implements Executor {
  specs: AgentSpec[] = []
  history = new Map<string, string[]>()
  released: string[] = []
  completed = new Map<string, Reply>()
  /** 每次调用时 agent 看到的工具名（带 mcp__<服务名>__ 前缀，和 dsh 的写法一样）。 */
  offered: string[][] = []
  constructor(private readonly script: McpScript) {}

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    this.specs.push(p.spec)
    const history = this.history.get(p.key) ?? []
    const clients = p.spec.profile.mcp.filter(isHttpMcp).map(m => ({ prefix: `mcp__${m.name}__`, client: new McpClient(m) }))
    const tools = new Map<string, { client: McpClient; raw: string }>()
    for (const c of clients) for (const raw of await c.client.tools()) tools.set(`${c.prefix}${raw}`, { client: c.client, raw })
    this.offered.push([...tools.keys()])
    const results: string[] = []
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let step = 0
    for (;;) {
      step++
      usage.input += 100
      usage.output += 10
      const next = this.script({ key: p.key, prompt: p.prompt, history, results, spec: p.spec })
      if ('reply' in next) {
        p.onEvent?.({ kind: 'model', t: step, step, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, reasoning: '', text: next.reply, toolCalls: [] })
        this.history.set(p.key, [...history, p.prompt])
        return { sessionId: `s:${p.key}`, text: next.reply, usage, ms: 5 * step, model: 'fake' }
      }
      const callId = `t${step}`
      const args = JSON.stringify(next.args)
      p.onEvent?.({ kind: 'model', t: step, step, usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, reasoning: '', text: '', toolCalls: [{ id: callId, name: next.tool, args }] })
      p.onEvent?.({ kind: 'tool_start', t: step, step, id: callId, name: next.tool, args })
      const target = tools.get(next.tool)
      const out = target === undefined ? { text: '（自带工具：假执行器不执行）', isError: false } : await target.client.call(target.raw, next.args)
      p.onEvent?.({ kind: 'tool_end', t: step, id: callId, output: out.text, isError: out.isError })
      results.push(out.text)
    }
  }
  async findReply(_key: string, nonce: string) {
    return this.completed.get(nonce)
  }
  async traceOf() {
    return []
  }
  async release(cwd: string) {
    this.released.push(cwd)
  }
  async close() {}
}
