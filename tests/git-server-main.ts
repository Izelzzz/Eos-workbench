// 测试用的 git HTTP 服务，在单独的进程里跑：和测试进程互不阻塞，测试进程退出时一起结束。
// 用法：node --import tsx tests/git-server-main.ts <仓库根目录> <令牌或 -> <记录文件>
// 令牌不是 - 时，只接受 "Authorization: Basic base64(x-access-token:<令牌>)"，否则 401。每个请求的认证头追加到记录文件。
// 另外模拟 GitHub 的 PR 接口（/api/v3/repos/<owner>/<repo>/pulls 的 GET 和 POST），要求 "Authorization: Bearer <令牌>"；PR 存在内存里。
// 再模拟 GitHub App：环境变量 EOS_TEST_APP_ID、EOS_TEST_APP_KEY（公钥 PEM 文件）、EOS_TEST_APP_INSTALLED（装了 App 的 owner/repo，逗号分隔）、
// EOS_TEST_APP_TTL_MS（安装令牌的有效期）。查安装和换令牌要用 App 私钥签的 JWT；换出的令牌在有效期内，git 和 PR 接口都认。
// 还模拟清单流程注册 App：POST /settings/apps/new?state=…（或 /organizations/<org>/settings/apps/new）收下清单，新生成一个 App（换掉上面的 App），
// 不经确认页直接 302 跳回清单里的 redirect_url（带 code 和 state）；POST /api/v3/app-manifests/<code>/conversions 用 code 换 App 的 id 和私钥，code 只能用一次。
// 收到的清单写进记录文件（path 是表单地址，manifest 是清单）。
// 再模拟 GitHub App 的用户授权（OAuth）：GET /login/oauth/authorize 直接 302 跳回 redirect_uri（带 code 和 state，不经确认页）；
// POST /login/oauth/access_token 用 code 或刷新令牌换用户令牌（刷新令牌每次换新、旧的作废），GET /api/v3/user 返回授权人 octo，
// DELETE /api/v3/applications/<client_id>/grant 撤销。用户令牌只能访问装了 App 的仓库，有效期是 EOS_TEST_USER_TTL_S 秒（默认 8 小时）。
// 控制接口：/__control/expire-user 让现有的用户令牌立即过期；/__control/deny-next 让下一次授权被用户拒绝。
import { execFileSync, spawn } from 'node:child_process'
import { createPublicKey, createVerify, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

const [root, token, record] = process.argv.slice(2) as [string, string, string]
let appId = process.env.EOS_TEST_APP_ID
let appKey: KeyObject | undefined = process.env.EOS_TEST_APP_KEY === undefined ? undefined : createPublicKey(readFileSync(process.env.EOS_TEST_APP_KEY))
/** 清单流程里发出去、还没换过的 code。 */
const conversions = new Map<string, { id: number; slug: string; pem: string; name: string; clientId: string; clientSecret: string }>()
/** 当前 App 的 client id 和 secret（清单流程注册时生成）。 */
let client: { id: string; secret: string } | undefined
/** 用户授权：发出去的授权码（→ 当时的 redirect_uri）、用户令牌（→ 到期时间）、刷新令牌（还能用的）。 */
const userCodes = new Map<string, string>()
const userTokens = new Map<string, number>()
const refreshTokens = new Set<string>()
const userTtl = Number(process.env.EOS_TEST_USER_TTL_S ?? 28800)
const userControl = { denyNext: false }
const issueUser = () => {
  const access = `ghu_${randomBytes(12).toString('hex')}`
  const refresh = `ghr_${randomBytes(12).toString('hex')}`
  userTokens.set(access, Date.now() + userTtl * 1000)
  refreshTokens.add(refresh)
  return { access_token: access, token_type: 'bearer', expires_in: userTtl, refresh_token: refresh, refresh_token_expires_in: 15897600 }
}
const installed = (process.env.EOS_TEST_APP_INSTALLED ?? '').split(',').filter(Boolean)
const ttl = Number(process.env.EOS_TEST_APP_TTL_MS ?? 3600_000)
/** 换出去的安装令牌：令牌 → 到期时间和授权的仓库。 */
const issued = new Map<string, { expires: number; repos: string[] }>()

/** 认这个令牌吗：固定的令牌，或在有效期内、授权了这个仓库的安装令牌。 */
const accepts = (t: string, repo: string): boolean => {
  if (token !== '-' && t === token) return true
  // 用户令牌：没过期，而且 App 装到了这个仓库（GitHub App 的用户令牌只能访问这样的仓库）。
  const u = userTokens.get(t)
  if (u !== undefined) return u > Date.now() && installed.some(x => x.toLowerCase() === repo.toLowerCase())
  const i = issued.get(t)
  return i !== undefined && i.expires > Date.now() && i.repos.includes(repo)
}

/** App 的 JWT：签名用 App 的公钥验证，iss 是 App id，没过期。 */
const validJwt = (auth: string | undefined): boolean => {
  const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? '')
  if (m === null || appKey === undefined) return false
  const v = createVerify('RSA-SHA256')
  v.update(`${m[1]}.${m[2]}`)
  if (!v.verify(appKey, Buffer.from(m[3]!, 'base64url'))) return false
  const body = JSON.parse(Buffer.from(m[2]!, 'base64url').toString('utf8')) as { iss?: string; exp?: number; iat?: number }
  const now = Date.now() / 1000
  // 真实 GitHub：exp 最多是现在加 10 分钟，exp - iat 也不能超过 10 分钟。
  return body.iss === appId && (body.exp ?? 0) > now && (body.iat ?? Infinity) <= now && (body.exp ?? Infinity) <= now + 600 && (body.exp ?? 0) - (body.iat ?? 0) <= 600
}

/** git 走 HTTPS 时的认证头（Basic x-access-token:<令牌>）认不认。 */
const gitAccepts = (auth: string | undefined, repo: string): boolean => {
  if (token === '-') return true
  const m = /^Basic (.+)$/.exec(auth ?? '')
  if (m === null) return false
  const [user, pass] = Buffer.from(m[1]!, 'base64').toString('utf8').split(':')
  return user === 'x-access-token' && pass !== undefined && accepts(pass, repo)
}

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
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
  if (token !== '-' && (bearer === undefined || !accepts(bearer, `${owner}/${name}`))) return reply(401, { message: 'Bad credentials' })
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
    else if (ctl[1] === 'revoke') issued.clear()
    else if (ctl[1] === 'install') installed.push(q.get('repo')!)
    else if (ctl[1] === 'expire-user') for (const k of userTokens.keys()) userTokens.set(k, 0)
    else if (ctl[1] === 'deny-next') userControl.denyNext = true
    else if (ctl[1] === 'merge' && pr !== undefined) Object.assign(pr, { state: 'closed', merged_at: new Date().toISOString() })
    res.writeHead(204)
    return void res.end()
  }
  // 清单流程：收下清单，生成 App，跳回平台。
  const newApp = /^\/(?:organizations\/[^/]+\/)?settings\/apps\/new\?state=([^&]*)$/.exec(req.url ?? '')
  if (newApp !== null && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const manifest = JSON.parse(new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('manifest') ?? '{}') as { name: string; redirect_url: string }
      appendFileSync(record, `${JSON.stringify({ path: req.url, manifest })}\n`)
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const id = 700 + conversions.size
      const code = randomBytes(10).toString('hex')
      conversions.set(code, { id, slug: manifest.name.toLowerCase(), pem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(), name: manifest.name, clientId: `Iv1.app${id}`, clientSecret: `secret_${randomBytes(10).toString('hex')}` })
      appId = String(id)
      appKey = publicKey
      const back = new URL(manifest.redirect_url)
      back.searchParams.set('code', code)
      back.searchParams.set('state', decodeURIComponent(newApp[1]!))
      res.writeHead(302, { location: back.toString() })
      res.end()
    })
    return
  }
  const conv = /^\/api\/v3\/app-manifests\/([^/]+)\/conversions$/.exec(req.url ?? '')
  if (conv !== null && req.method === 'POST') {
    const c = conversions.get(decodeURIComponent(conv[1]!))
    conversions.delete(decodeURIComponent(conv[1]!))
    if (c !== undefined) client = { id: c.clientId, secret: c.clientSecret }
    res.writeHead(c === undefined ? 404 : 201, { 'content-type': 'application/json' })
    // 真实 GitHub 还返回 client_secret、webhook_secret：平台不该存它们。
    return void res.end(JSON.stringify(c === undefined ? { message: 'Not Found' } : { id: c.id, slug: c.slug, name: c.name, pem: c.pem, html_url: `http://127.0.0.1:${port}/apps/${c.slug}`, client_id: c.clientId, client_secret: c.clientSecret, webhook_secret: 'webhook-secret-should-not-be-stored' }))
  }
  // 用户授权：授权页直接跳回。
  const authz = /^\/login\/oauth\/authorize\?(.*)$/.exec(req.url ?? '')
  if (authz !== null && req.method === 'GET') {
    const q = new URLSearchParams(authz[1])
    appendFileSync(record, `${JSON.stringify({ path: '/login/oauth/authorize', query: Object.fromEntries(q) })}\n`)
    if (client === undefined || q.get('client_id') !== client.id) {
      res.writeHead(404)
      return void res.end('unknown client_id')
    }
    const back = new URL(q.get('redirect_uri')!)
    back.searchParams.set('state', q.get('state') ?? '')
    if (userControl.denyNext) {
      userControl.denyNext = false
      back.searchParams.set('error', 'access_denied')
    } else {
      const code = randomBytes(10).toString('hex')
      userCodes.set(code, q.get('redirect_uri')!)
      back.searchParams.set('code', code)
    }
    res.writeHead(302, { location: back.toString() })
    return void res.end()
  }
  if (req.url === '/login/oauth/access_token' && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (b: Buffer) => chunks.push(b))
    req.on('end', () => {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>
      appendFileSync(record, `${JSON.stringify({ path: req.url, grant: b.grant_type ?? 'code' })}\n`)
      // 真实 GitHub：出错也回 200，带 error。
      const reply = (v: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
      if (client === undefined || b.client_id !== client.id || b.client_secret !== client.secret) return reply({ error: 'incorrect_client_credentials' })
      if (b.grant_type === 'refresh_token') {
        if (!refreshTokens.delete(b.refresh_token!)) return reply({ error: 'bad_refresh_token' })
        return reply(issueUser())
      }
      const redirect = userCodes.get(b.code!)
      userCodes.delete(b.code!)
      if (redirect === undefined || redirect !== b.redirect_uri) return reply({ error: 'bad_verification_code' })
      return reply(issueUser())
    })
    return
  }
  if (req.url === '/api/v3/user' && req.method === 'GET') {
    const t = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const ok = t !== undefined && (userTokens.get(t) ?? 0) > Date.now()
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify(ok ? { login: 'octo', id: 1 } : { message: 'Bad credentials' }))
  }
  const grant = /^\/api\/v3\/applications\/([^/]+)\/grant$/.exec(req.url ?? '')
  if (grant !== null && req.method === 'DELETE') {
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8')
    const ok = client !== undefined && basic === `${client.id}:${client.secret}`
    if (ok) { userTokens.clear(); refreshTokens.clear() }
    appendFileSync(record, `${JSON.stringify({ path: req.url, method: 'DELETE', ok })}\n`)
    res.writeHead(ok ? 204 : 401)
    return void res.end()
  }
  // GitHub App：查安装、换安装令牌。
  const inst = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(req.url ?? '')
  const mint = /^\/api\/v3\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url ?? '')
  if (inst !== null || mint !== null) {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      appendFileSync(record, `${JSON.stringify({ path: req.url, method: req.method, auth: req.headers.authorization === undefined ? null : 'jwt', ...(body === '' ? {} : { body: JSON.parse(body) }) })}\n`)
      const reply = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (!validJwt(req.headers.authorization)) return reply(401, { message: 'A JSON web token could not be decoded' })
      if (inst !== null) {
        const repo = `${decodeURIComponent(inst[1]!)}/${decodeURIComponent(inst[2]!)}`
        // GitHub 的 owner 和仓库名不分大小写。
        const i = installed.findIndex(x => x.toLowerCase() === repo.toLowerCase())
        return i < 0 ? reply(404, { message: 'Not Found' }) : reply(200, { id: 1000 + i })
      }
      const i = Number(mint![1]) - 1000
      const repos = (JSON.parse(body || '{}') as { repositories?: string[] }).repositories ?? []
      const owner = installed[i]?.split('/')[0]
      if (owner === undefined) return reply(404, { message: 'Not Found' })
      const allowed = repos.map(r => `${owner}/${r}`).filter(r => installed.includes(r))
      if (allowed.length !== repos.length) return reply(422, { message: 'There is at least one repository that does not exist or is not accessible' })
      const t = `ghs_${randomBytes(12).toString('hex')}`
      const expires = Date.now() + ttl
      issued.set(t, { expires, repos: allowed })
      return reply(201, { token: t, expires_at: new Date(expires).toISOString() })
    })
    return
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
  const gitRepo = /^\/([^/]+)\/([^/]+?)\.git\//.exec(req.url ?? '')
  if (!gitAccepts(req.headers.authorization, gitRepo === null ? '' : `${gitRepo[1]}/${gitRepo[2]}`)) {
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
