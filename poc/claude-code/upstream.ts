// Claude Code 的上游：agent 进程的 ANTHROPIC_BASE_URL 指向这里，进程里只有假 key。
// - 真实模式：转发到 api.anthropic.com，转发时才换上平台持有的凭据（EOS_ANTHROPIC_API_KEY 或 EOS_CLAUDE_OAUTH_TOKEN）。
// - mock 模式（EOS_MOCK=1）：按剧本回复，强制 agent 发起指定的工具调用，用来确定性地验证平台侧的限制。
// 两种模式都把收到的请求体记下来，脚本可以核对真正发给模型的系统提示、工具表和消息。
import http from 'node:http'
import { Readable } from 'node:stream'

export type Block = { text: string } | { thinking: string } | { tool: string; input: Record<string, unknown> }
export type Ctx = { lastToolResult: string; allText: string }
/** 剧本的一步：给出这一轮模型要回复的内容块。剧本走完以后回复 "done"。 */
export type Step = (c: Ctx) => Block[]

export const MOCK = process.env.EOS_MOCK === '1'
const scripts = new Map<string, Step[]>()
export const requests: any[] = []

const texts = (m: any): string[] => typeof m.content === 'string' ? [m.content]
  : (m.content ?? []).flatMap((c: any) => c.type === 'text' ? [c.text] : c.type === 'tool_result' ? [typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join('')] : [])

/** 注册一份剧本，返回要放进提示词里的标记。真实模式下返回空串，提示词不变。 */
export const script = (name: string, steps: Step[]): string => {
  scripts.set(name, steps)
  return MOCK ? `[[mock:${name}]] ` : ''
}

const reply = (body: any): Block[] => {
  const msgs: any[] = body.messages ?? []
  let at = -1, name = ''
  msgs.forEach((m, i) => { if (m.role !== 'user') return; for (const t of texts(m)) { const x = /\[\[mock:([\w-]+)\]\]/.exec(t); if (x) { at = i; name = x[1]! } } })
  const steps = scripts.get(name)
  if (!steps) return [{ text: 'ok' }]
  const n = msgs.slice(at + 1).filter(m => m.role === 'assistant').length
  const last = msgs.at(-1)
  const lastToolResult = last?.role === 'user' ? (last.content ?? []).filter((c: any) => c.type === 'tool_result').flatMap((c: any) => texts({ content: [c] })).join('\n') : ''
  const allText = JSON.stringify(body.system ?? '') + '\n' + msgs.flatMap(texts).join('\n')
  return n < steps.length ? steps[n]!({ lastToolResult, allText }) : [{ text: 'done' }]
}

let seq = 0
const sse = (res: http.ServerResponse, model: string, blocks: Block[]) => {
  const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  send('message_start', { message: { id: `msg_mock_${++seq}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 25 } } })
  blocks.forEach((b, index) => {
    if ('text' in b) {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else if ('thinking' in b) {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } })
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'mock' } })
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: `toolu_mock_${seq}_${index}`, name: b.tool, input: {} } })
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: blocks.some(b => 'tool' in b) ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
  send('message_stop', {})
  res.end()
}

const forward = async (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !/^(host|connection|content-length|x-api-key|authorization|accept-encoding)$/.test(k)) headers[k] = v
  if (process.env.EOS_AUTH === 'oauth') headers.authorization = `Bearer ${process.env.EOS_CLAUDE_OAUTH_TOKEN}`
  else headers['x-api-key'] = process.env.EOS_ANTHROPIC_API_KEY ?? ''
  const r = await fetch(`https://api.anthropic.com${req.url}`, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body) })
  const out: Record<string, string> = {}
  r.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/.test(k)) out[k] = v })
  res.writeHead(r.status, out)
  if (r.body) Readable.fromWeb(r.body as any).pipe(res)
  else res.end()
}

/** 在本机随机端口起上游，返回 base URL。 */
export const startUpstream = (): Promise<{ url: string; close: () => void }> => new Promise(ok => {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      let json: any
      try { json = JSON.parse(body.toString('utf8')) } catch { json = undefined }
      if (json && req.method === 'POST' && /\/v1\/messages(\?|$)/.test(req.url ?? '')) requests.push(json)
      if (!MOCK) { forward(req, body, res).catch(e => { if (!res.headersSent) res.writeHead(502); res.end(String(e)) }); return }
      if (json && /\/v1\/messages(\?|$)/.test(req.url ?? '')) {
        const blocks = reply(json)
        if (json.stream) sse(res, json.model, blocks)
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: json.model, content: blocks.map(b => 'text' in b ? { type: 'text', text: b.text } : { type: 'text', text: '' }), stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })) }
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
    })
  })
  srv.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(srv.address() as any).port}`, close: () => srv.close() }))
})
