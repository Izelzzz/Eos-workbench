// Claude Code 的模型上游：平台在本机起的一个转发服务。Claude Code 进程的 ANTHROPIC_BASE_URL 指向这里，
// 它的 ANTHROPIC_API_KEY 只是这次调用的一次性令牌；转发到 Anthropic 时才换上平台持有的真 key。
// 真 key 不进 Claude Code 进程，agent 的 Bash 从自己的环境、/proc 里都读不到它（PoC 第 8 项：交给 Claude Code 的 key，agent 能读到）。
// 只认登记过、还没撤销的令牌：本机别的进程、调用结束后的 agent 都用不了平台的 key。
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 请求体的上限：模型请求带着整段对话，正常远小于这个值。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024
/** 回复的上限：一次模型回复（流式）远小于这个值；超过时断开，不让上游被当成下载通道。 */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/**
 * 只转发 Claude Code 调模型要用的：POST /v1/messages（和数 token 的 count_tokens）。别的路径和方法一律拒绝：
 * 上游带着平台的真 key，不能被当成通用代理（只发往配置的模型接口地址，见 anthropicBaseUrl）。
 */
const ALLOWED_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens'])

/** 不转发的请求头：认证由上游换成真 key，连接相关的由 fetch 自己处理。 */
const DROP_REQUEST = /^(host|connection|content-length|x-api-key|authorization|accept-encoding|proxy-authorization|keep-alive|transfer-encoding|upgrade)$/i
const DROP_RESPONSE = /^(content-encoding|content-length|transfer-encoding|connection|keep-alive)$/i

/**
 * 模型接口地址：默认官方接口；平台配置 EOS_ANTHROPIC_BASE_URL 时用它（CI 的假模型、本机网关）。
 * 和 dsh 的 EOS_MODEL_BASE_URL 一样：只接受 https，或者发往本机的 http；不带用户名和密码。报错里不带原始地址。
 */
export const anthropicBaseUrl = (env: NodeJS.ProcessEnv): string => {
  const raw = env.EOS_ANTHROPIC_BASE_URL
  if (raw === undefined || raw === '') return 'https://api.anthropic.com'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('EOS_ANTHROPIC_BASE_URL 不是合法的地址')
  }
  if (url.username !== '' || url.password !== '') throw new Error('EOS_ANTHROPIC_BASE_URL 里不能带用户名和密码')
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.href.replace(/\/$/, '')
  throw new Error(`EOS_ANTHROPIC_BASE_URL 只能是 https 地址，或者本机的 http 地址（现在是 ${url.protocol}//${url.host}）`)
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** 请求里带的令牌：Claude Code 用 API key 认证时放在 x-api-key，也接受 Authorization: Bearer。 */
const tokenOf = (req: IncomingMessage): string | undefined => {
  const x = req.headers['x-api-key']
  if (typeof x === 'string' && x !== '') return x
  const auth = req.headers.authorization
  return typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined
}

export class Upstream {
  private server: Server | undefined
  private starting: Promise<string> | undefined
  /** 登记的令牌 → 取真 key 的函数（每次转发时取，Web 上换了 key 之后的请求就用新的）。 */
  private readonly grants = new Map<string, () => string>()

  constructor(
    private readonly target: string,
    /** 请求体和回复的上限（测试里调小）。 */
    private readonly limits: { body: number; response: number } = { body: MAX_BODY_BYTES, response: MAX_RESPONSE_BYTES },
  ) {}

  /** 起服务（只听 127.0.0.1 的随机端口），返回地址。只起一次。 */
  url(): Promise<string> {
    this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        const a = server.address()
        resolve(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`)
      })
    })
    return this.starting
  }

  /** 给一次调用登记一个令牌；调用结束时 revoke，之后这个令牌就没用了。 */
  grant(key: () => string): { token: string; revoke: () => void } {
    const token = `sk-ant-eos-${randomBytes(24).toString('hex')}`
    this.grants.set(token, key)
    return { token, revoke: () => void this.grants.delete(token) }
  }

  get active(): number {
    return this.grants.size
  }

  private key(req: IncomingMessage): (() => string) | undefined {
    const t = tokenOf(req)
    if (t === undefined) return undefined
    for (const [token, key] of this.grants) if (same(token, t)) return key
    return undefined
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fail = (status: number, message: string) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'eos_upstream', message } }))
    }
    const key = this.key(req)
    if (key === undefined) return fail(401, '这个令牌不是平台登记的，或者那次调用已经结束')
    // 先规范化路径（去掉 ..、多余的斜杠）再核对：fetch 拼地址时会解析 ..，原样转发能跳出 /v1/
    const u = new URL(req.url ?? '/', 'http://upstream')
    if (!ALLOWED_PATHS.has(u.pathname) || /(^|\/)\.\.?(\/|$)|%2e/i.test(req.url ?? '')) return fail(404, '只转发模型接口（/v1/messages）')
    if (req.method !== 'POST') return fail(405, '只转发 POST 请求')
    // Claude Code 断开（调用被中止）时取消发往模型接口的请求，不再接着读、接着花 token
    const ac = new AbortController()
    res.on('close', () => ac.abort())
    const max = this.limits.response
    try {
      // 读完整个请求体；超过上限的部分丢掉，读完再回 413（读到一半就断开时客户端收不到回复）
      const limit = this.limits.body
      const body = await new Promise<Buffer | undefined>((ok, ko) => {
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size <= limit) chunks.push(c)
        })
        req.on('end', () => ok(size > limit ? undefined : Buffer.concat(chunks)))
        req.on('error', ko)
      })
      if (body === undefined) return fail(413, '请求太大')
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !DROP_REQUEST.test(k)) headers[k] = v
      headers['x-api-key'] = key()
      const r = await fetch(`${this.target}${u.pathname}${u.search}`, { method: 'POST', headers, signal: ac.signal, redirect: 'error', body: new Uint8Array(body) })
      const out: Record<string, string> = {}
      r.headers.forEach((v, k) => {
        if (!DROP_RESPONSE.test(k)) out[k] = v
      })
      res.writeHead(r.status, out)
      // 流到一半出错（模型接口断开、调用被中止）时 pipeline 关掉两端，错误落到下面的 catch，不会成为未处理的异常
      if (r.body === null) res.end()
      else {
        let sent = 0
        const cap = new Transform({
          transform(chunk: Buffer, _enc, done) {
            sent += chunk.length
            done(sent > max ? new Error('回复太大') : null, chunk)
          },
        })
        await pipeline(Readable.fromWeb(r.body as never), cap, res)
      }
    } catch (e) {
      // 已经开始回复时只能断开（Claude Code 会把这一轮当成出错）；被中止时也是
      if (ac.signal.aborted || res.headersSent) return void res.destroy()
      // 报错里不带 key：取 key 失败（例如凭据读不出来）的原因本身不含 key
      fail(502, `转发到模型接口失败：${(e as Error).message}`)
    }
  }

  close(): Promise<void> {
    this.grants.clear()
    const s = this.server
    this.server = undefined
    this.starting = undefined
    return new Promise(resolve => (s === undefined ? resolve() : s.close(() => resolve())))
  }
}
