// 假模型的 HTTP 服务：实现 dsh 用的 Anthropic Messages 接口（POST <base>/v1/messages，SSE 流式返回），回复由 script.ts 决定。
// dsh 经环境变量 DEEPSEEK_BASE_URL 指向这里（见 src/executor/dsh.ts 的 AGENT_ENV_KEEP）。
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decide, type Reply, type Request } from './script.ts'

export type FakeModel = { baseUrl: string; requests: () => number; close: () => Promise<void> }

/** 把一次回复写成 Anthropic Messages 的 SSE 事件序列 */
export function sse(reply: Reply, id: string): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const block =
    reply.kind === 'text'
      ? [
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } }),
        ]
      : [
          ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${id}`, name: reply.name, input: {} } }),
          ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) } }),
        ]
  return [
    ev('message_start', { message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } }),
    ...block,
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 10 } }),
    ev('message_stop', {}),
  ].join('')
}

/** 在本机随机端口起服务。onRequest 收到每个请求和回复，用来写日志 */
export async function startFakeModel(onRequest: (req: Request, reply: Reply) => void = () => {}): Promise<FakeModel> {
  let count = 0
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `假模型只实现 POST /v1/messages，收到 ${req.method} ${req.url}` } }))
        return
      }
      const request = JSON.parse(body) as Request
      const reply = decide(request)
      count++
      onRequest(request, reply)
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(reply, String(count)))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/anthropic`,
    requests: () => count,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}
