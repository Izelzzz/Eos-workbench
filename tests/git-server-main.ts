// 测试用的 git HTTP 服务，在单独的进程里跑：和测试进程互不阻塞，测试进程退出时一起结束。
// 用法：node --import tsx tests/git-server-main.ts <仓库根目录> <令牌或 -> <记录文件>
// 令牌不是 - 时，只接受 "Authorization: Basic base64(x-access-token:<令牌>)"，否则 401。每个请求的认证头追加到记录文件。
// 另外模拟 GitHub 的 PR 接口（/api/v3/repos/<owner>/<repo>/pulls 的 GET 和 POST），要求 "Authorization: Bearer <令牌>"；PR 存在内存里。
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const [root, token, record] = process.argv.slice(2) as [string, string, string]
const expected = token === '-' ? undefined : `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`

type Pull = { number: number; head: string; base: string; title: string; body: string; state: 'open' }
const pulls: Pull[] = []
let port = 0

const api = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, owner: string, name: string, body: string) => {
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (token !== '-' && req.headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' })
  const gitDir = `${root}/${owner}/${name}.git`
  const html = (n: number) => `http://127.0.0.1:${port}/${owner}/${name}/pull/${n}`
  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const head = url.searchParams.get('head')
    const base = url.searchParams.get('base')
    return reply(200, pulls.filter(p => (head === null || `${owner}:${p.head}` === head) && (base === null || p.base === base)).map(p => ({ number: p.number, html_url: html(p.number) })))
  }
  const p = JSON.parse(body) as { title: string; head: string; base: string; body: string }
  let ahead = 0
  try {
    ahead = Number(execFileSync('git', ['--git-dir', gitDir, 'rev-list', '--count', `refs/heads/${p.base}..refs/heads/${p.head}`], { encoding: 'utf8' }).trim())
  } catch {
    return reply(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] })
  }
  if (ahead === 0) return reply(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${p.base} and ${p.head}` }] })
  const pr: Pull = { number: pulls.length + 1, head: p.head, base: p.base, title: p.title, body: p.body, state: 'open' }
  pulls.push(pr)
  return reply(201, { number: pr.number, html_url: html(pr.number) })
}

const server = createServer((req, res) => {
  const apiPath = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls(?:\?.*)?$/.exec(req.url ?? '')
  if (apiPath !== null) {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      appendFileSync(record, `${JSON.stringify({ path: req.url, method: req.method, auth: req.headers.authorization ?? null, ...(body === '' ? {} : { body: JSON.parse(body) }) })}\n`)
      api(req, res, decodeURIComponent(apiPath[1]!), decodeURIComponent(apiPath[2]!), body)
    })
    return
  }
  appendFileSync(record, `${JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null })}\n`)
  if (expected !== undefined && req.headers.authorization !== expected) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="eos-test"' })
    return res.end()
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
      REMOTE_USER: 'eos-test', REMOTE_ADDR: '127.0.0.1', GIT_HTTP_RECEIVE_PACK: 'true',
    },
  })
  req.pipe(child.stdin)
  const out: Buffer[] = []
  child.stdout.on('data', (b: Buffer) => out.push(b))
  child.on('close', () => {
    const all = Buffer.concat(out)
    const split = all.indexOf('\r\n\r\n')
    const head = all.subarray(0, split).toString('latin1')
    const headers: Record<string, string> = {}
    let status = 200
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':')
      const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()]
      if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10)
      else if (k !== '') headers[k] = v
    }
    res.writeHead(status, headers)
    res.end(all.subarray(split + 4))
  })
})
server.listen(0, '127.0.0.1', () => {
  port = (server.address() as AddressInfo).port
  process.stdout.write(`port ${port}\n`)
})
