// 假的 Anthropic 模型接口（Messages API 的流式回复），给 Claude Code 执行器的测试用：真的启动 Claude Code，不调真模型。
// 默认回复「claude-code：<这次用户消息的第一行>」；reply 可以换成剧本（例如先调一个工具，再回复文字）。
// 记下每个请求的 x-api-key 和请求体：测试据此核对上游换上了平台的 key、发给模型的工具表。
import { createServer, type Server } from 'node:http'

export type Block = { text: string } | { thinking: string } | { tool: string; input: Record<string, unknown> }
export type Req = { key: string | undefined; body: { model?: string; messages?: { role: string; content: unknown }[]; tools?: { name: string }[]; system?: unknown } }

const texts = (content: unknown): string[] =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((c: { type?: string; text?: string; content?: unknown }) =>
          c.type === 'text' ? [c.text ?? ''] : c.type === 'tool_result' ? [typeof c.content === 'string' ? c.content : texts(c.content).join('')] : [],
        )
      : []

/** 最后一条（不是工具结果的）用户消息的文字。 */
export const lastPrompt = (r: Req): string => {
  const users = (r.body.messages ?? []).filter(m => m.role === 'user')
  for (const m of users.reverse()) {
    const t = (Array.isArray(m.content) ? (m.content as { type?: string }[]).filter(c => c.type === 'text') : [m.content]).flatMap(c => texts(Array.isArray(c) ? c : [c]))
    const s = (typeof m.content === 'string' ? m.content : t.join('')).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (s !== '') return s
  }
  return ''
}

/** 当前这一轮里模型已经回复了几次：带 nonce 标记（平台发的那条）的最后一条用户消息之后的 assistant 消息数。 */
export const stepOf = (r: Req): number => {
  const msgs = r.body.messages ?? []
  const at = msgs.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes('<!-- eos:'))
  return msgs.slice(at + 1).filter(m => m.role === 'assistant').length
}

export const defaultReply = (r: Req): Block[] => [{ text: `claude-code：${lastPrompt(r).split('\n')[0]}` }]

export class FakeAnthropic {
  readonly requests: Req[] = []
  private server: Server | undefined
  private seq = 0
  reply: (r: Req) => Block[] = defaultReply

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        let body: Req['body'] = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Req['body']
        } catch {
          // 不是 JSON 的请求按空请求体处理
        }
        const key = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined
        if (!/^\/v1\/messages(\?|$)/.test(req.url ?? '') || req.method !== 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
          return
        }
        const r: Req = { key, body }
        this.requests.push(r)
        this.sse(res, body.model ?? 'fake', this.reply(r))
      })
    })
    this.server = server
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
    const a = server.address()
    return `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`
  }

  private sse(res: import('node:http').ServerResponse, model: string, blocks: Block[]): void {
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const n = ++this.seq
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    send('message_start', {
      message: {
        id: `msg_fake_${n}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    blocks.forEach((b, index) => {
      if ('text' in b) {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
      } else if ('thinking' in b) {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
        send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } })
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'fake' } })
      } else {
        send('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_fake_${n}_${index}`, name: b.tool, input: {} } })
        send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
      }
      send('content_block_stop', { index })
    })
    send('message_delta', { delta: { stop_reason: blocks.some(b => 'tool' in b) ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
    send('message_stop', {})
    res.end()
  }

  close(): Promise<void> {
    const s = this.server
    return new Promise(ok => (s === undefined ? ok() : s.close(() => ok())))
  }
}
