// 假模型的 HTTP 服务：实现 dsh 用的 Anthropic Messages 接口（POST <base>/v1/messages，SSE 流式返回），回复由 script.ts 决定。
// 平台经 EOS_MODEL_BASE_URL 指向这里，作为 DEEPSEEK_BASE_URL 交给 dsh（见 src/executor/dsh.ts 的 modelBaseUrl）。
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { decide, type Reply, type Request } from './script.ts'

export type FakeModel = { baseUrl: string; requests: () => number; close: () => Promise<void> }

/** 把一次回复写成 Anthropic Messages 的 SSE 事件序列 */
export function sse(reply: Reply, id: string): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const block =
    reply.kind === 'text'
      ? [ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }), ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply.text } })]
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

/** 不流式时的整条回复（Anthropic Messages 的 message 对象） */
export function message(reply: Reply, id: string): Record<string, unknown> {
  const content = reply.kind === 'text' ? [{ type: 'text', text: reply.text }] : [{ type: 'tool_use', id: `toolu_${id}`, name: reply.name, input: reply.input }]
  return { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'fake', content, stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use', usage: { input_tokens: 100, output_tokens: 10 } }
}

/** 在本机随机端口起服务。onRequest 收到每个请求和回复，用来写日志；script 决定回复（默认是 script.ts 的任务剧本） */
export async function startFakeModel(onRequest: (req: Request, reply: Reply) => void = () => {}, script: (req: Request) => Reply | Promise<Reply> = decide): Promise<FakeModel> {
  let count = 0
  const fail = (res: ServerResponse, status: number, message: string) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `假模型：${message}` } }))
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      // 数 token 的请求（Claude Code 可能发）：回一个固定的数
      if (req.method === 'POST' && path.endsWith('/v1/messages/count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }))
      if (req.method !== 'POST' || !path.endsWith('/v1/messages')) return fail(res, 404, `只实现 POST /v1/messages，收到 ${req.method} ${req.url}`)
      try {
        const raw = JSON.parse(body) as { stream?: boolean; messages?: { role: string; content: unknown }[] }
        // 协议允许 content 是一个字符串，统一成块的数组
        const request = { ...raw, messages: (raw.messages ?? []).map(m => ({ ...m, content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content })) } as Request
        // 剧本可以是异步的（例如每步之间停一下，看页面上的按步推送）。
        const reply = await script(request)
        count++
        onRequest(request, reply)
        if (raw.stream === true) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(reply, String(count)))
        // 不流式的请求（执行器的辅助请求可能这样发）：同一个回复，一次给完
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message(reply, String(count))))
      } catch (e) {
        fail(res, 400, `处理请求出错：${(e as Error).message}`)
      }
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
