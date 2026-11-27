// 对话 agent 读平台数据的 MCP 端点：标准的 MCP Streamable HTTP（只用 JSON 回复，不开 SSE 流），监听 127.0.0.1 的随机端口。
// 每次调用开一个、调用结束就关：端口和令牌都只活一次调用。同一台机器上的别的进程（别的任务的 agent、检查命令）也连得到这个端口，
// 所以令牌是唯一的防线：每次新生成 32 字节随机数，按定长比较（先各自算 sha256 再 timingSafeEqual）。
// 只有只读工具（tools.ts）。请求体、单次调用的工具调用次数都有上限；返回的大小由 tools.ts 截断。
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpMcp } from '../executor/types.ts'
import type { ToolOutcome } from './tools.ts'
import type { ChatRead } from './types.ts'

export const MAX_BODY_BYTES = 64 * 1024
/** 一次调用（用户说一句话，agent 回一次）里最多读几次数据。到了上限，之后的工具调用都返回错误，agent 只能根据已经读到的回答。 */
export const MAX_TOOL_CALLS = 30
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export type McpTool = { name: string; description: string; inputSchema: unknown }

export type McpEndpoint = {
  /** 交给执行器的端点：地址和带令牌的请求头。 */
  mcp: HttpMcp
  /** 到目前为止 agent 读了哪些数据（按调用顺序）。 */
  reads: () => ChatRead[]
  close: () => Promise<void>
}

const digest = (s: string) => createHash('sha256').update(s).digest()

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> }

const parseRpc = (body: string): RpcRequest | undefined => {
  try {
    const v = JSON.parse(body) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
    const r = v as Record<string, unknown>
    if (r.jsonrpc !== '2.0' || typeof r.method !== 'string') return undefined
    if (r.params !== undefined && (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params))) return undefined
    if (r.id !== undefined && r.id !== null && typeof r.id !== 'string' && typeof r.id !== 'number') return undefined
    return r as RpcRequest
  } catch {
    return undefined
  }
}

const readBody = (req: IncomingMessage): Promise<string | undefined> =>
  new Promise(resolve => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) over = true
      else chunks.push(c)
    })
    req.on('end', () => resolve(over ? undefined : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(undefined))
  })

export const openEndpoint = async (o: { name: string; tools: McpTool[]; call: (name: string, args: unknown) => ToolOutcome; maxCalls?: number }): Promise<McpEndpoint> => {
  const token = randomBytes(32).toString('base64url')
  const expected = digest(`Bearer ${token}`)
  const session = randomUUID()
  const max = o.maxCalls ?? MAX_TOOL_CALLS
  const reads: ChatRead[] = []
  let port = 0

  const send = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'mcp-session-id': session })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const reject = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(message)
  }

  const answer = (r: RpcRequest): unknown => {
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id: r.id, result })
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id: r.id ?? null, error: { code, message } })
    switch (r.method) {
      case 'initialize': {
        const asked = r.params?.protocolVersion
        const version = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]
        return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: o.name, version: '1' } })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({ tools: o.tools })
      case 'tools/call': {
        const name = r.params?.name
        if (typeof name !== 'string') return err(-32602, 'tools/call 需要 name')
        const args = r.params?.arguments
        if (reads.length >= max) {
          reads.push({ tool: name, args: JSON.stringify(args ?? {}), isError: true })
          return ok({ content: [{ type: 'text', text: `这一轮读取数据的次数已经到上限（${max} 次），不能再读：请根据已经读到的内容回答。` }], isError: true })
        }
        const out = o.call(name, args)
        reads.push({ tool: name, args: JSON.stringify(args ?? {}), isError: out.isError })
        return ok({ content: [{ type: 'text', text: out.text }], isError: out.isError })
      }
      default:
        return err(-32601, `不支持的方法 ${r.method}`)
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      // 只认本机地址的 Host（挡住 DNS rebinding）；浏览器发来的请求（带 Origin）一律拒绝。
      if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return reject(res, 403, 'forbidden')
      const auth = req.headers.authorization
      if (typeof auth !== 'string' || !timingSafeEqual(digest(auth), expected)) return reject(res, 401, 'unauthorized')
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path !== '/mcp') return reject(res, 404, 'not found')
      // 不提供服务端推送的 SSE 流（GET），也没有会话要删（DELETE）。
      if (req.method !== 'POST') return reject(res, 405, 'method not allowed')
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return reject(res, 415, 'unsupported media type')
      const body = await readBody(req)
      if (body === undefined) return reject(res, 413, 'payload too large')
      const rpc = parseRpc(body)
      if (rpc === undefined) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法的 JSON-RPC 请求' } })
      // 通知和回复（没有 id）不需要回答。
      if (rpc.id === undefined) return send(res, 202)
      return send(res, 200, answer(rpc))
    })().catch(() => {
      if (!res.headersSent) reject(res, 500, 'internal error')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  return {
    mcp: { name: o.name, url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    reads: () => [...reads],
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
