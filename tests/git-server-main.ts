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

type Pull = { number: number; head: string; base: string; title: string; body: string; state: 'open' | 'closed'; merged_at: string | null; sha: string }
/** 测试用的开关：hideNextList 让下一次查打开的 PR 返回空（模拟查和开之间别人刚开了一个）；failPost 让开 PR 返回这个状态码。 */
const control = { hideNextList: false, failPost: 0 }
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
    const state = url.searchParams.get('state') ?? 'open'
    if (state === 'open' && control.hideNextList) {
      control.hideNextList = false
      return reply(200, [])
    }
    return reply(200, pulls.filter(p => (head === null || `${owner}:${p.head}` === head) && (base === null || p.base === base) && (state === 'all' || p.state === state))
      .map(p => ({ number: p.number, html_url: html(p.number), merged_at: p.merged_at, head: { sha: p.sha } })))
  }
  if (control.failPost !== 0) return reply(control.failPost, { message: 'Resource not accessible by integration' })
  const p = JSON.parse(body) as { title: string; head: string; base: string; body: string }
  // 真实 GitHub：同一个分支已经有打开的 PR 时返回 422 "already exists"。
  if (pulls.some(x => x.head === p.head && x.state === 'open')) return reply(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${owner}:${p.head}.` }] })
  let ahead = 0
  try {
    ahead = Number(execFileSync('git', ['--git-dir', gitDir, 'rev-list', '--count', `refs/heads/${p.base}..refs/heads/${p.head}`], { encoding: 'utf8' }).trim())
  } catch {
    return reply(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] })
  }
  if (ahead === 0) return reply(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `No commits between ${p.base} and ${p.head}` }] })
  const sha = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `refs/heads/${p.head}`], { encoding: 'utf8' }).trim()
  const pr: Pull = { number: pulls.length + 1, head: p.head, base: p.base, title: p.title, body: p.body, state: 'open', merged_at: null, sha }
  pulls.push(pr)
  return reply(201, { number: pr.number, html_url: html(pr.number) })
}

const server = createServer((req, res) => {
  // 测试用的控制接口：/__control/<hide-next-list | fail-post?status=N | close?n=N | merge?n=N>。
  const ctl = /^\/__control\/([a-z-]+)(?:\?(.*))?$/.exec(req.url ?? '')
  if (ctl !== null) {
    const q = new URLSearchParams(ctl[2] ?? '')
    const pr = pulls.find(x => x.number === Number(q.get('n')))
    if (ctl[1] === 'hide-next-list') control.hideNextList = true
    else if (ctl[1] === 'fail-post') control.failPost = Number(q.get('status'))
    else if (ctl[1] === 'close' && pr !== undefined) pr.state = 'closed'
    else if (ctl[1] === 'merge' && pr !== undefined) Object.assign(pr, { state: 'closed', merged_at: new Date().toISOString() })
    res.writeHead(204)
    return void res.end()
  }
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
