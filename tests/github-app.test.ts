import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { appCredential, appJwt, GitHubApp, REFRESH_BEFORE_MS } from '../src/forge/github-app.ts'
import { githubForge } from '../src/forge/github.ts'
import { NotInstalled } from '../src/forge/types.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const repo = githubForge().parse('https://github.com/acme/app')!

test('App 的 JWT：RS256 签名能用公钥验证，iss 是 App id，iat 往前拨 60 秒，10 分钟内有效', () => {
  const now = 1_700_000_000_000
  const [h, b, sig] = appJwt('42', privateKey, now).split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' })
  const body = JSON.parse(Buffer.from(b!, 'base64url').toString())
  assert.deepEqual(body, { iat: now / 1000 - 60, exp: now / 1000 - 60 + 600, iss: '42' })
  const v = createVerify('RSA-SHA256')
  v.update(`${h}.${b}`)
  assert.ok(v.verify(publicKey, Buffer.from(sig!, 'base64url')))
})

/** 假的 GitHub：记下请求；安装令牌 1 小时有效。 */
const fakeGitHub = (o: { installed?: boolean; failMint?: number } = {}) => {
  const calls: string[] = []
  let failures = o.failMint ?? 0
  let n = 0
  const fake: typeof globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
    await new Promise(r => setTimeout(r, 5))
    if (url.endsWith('/installation')) return o.installed === false ? new Response('{"message":"Not Found"}', { status: 404 }) : Response.json({ id: 7 })
    if (failures > 0) {
      failures--
      return new Response('{"message":"boom"}', { status: 500 })
    }
    return Response.json({ token: `ghs_${++n}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 })
  }) as typeof globalThis.fetch
  return { calls, fetch: fake }
}

const make = (gh: ReturnType<typeof fakeGitHub>, now?: () => number) =>
  new GitHubApp({
    apiUrl: 'https://api.github.com',
    credential: appCredential.parse({ appId: 42, privateKey: pem }),
    credentialName: 'github-app.github.com',
    fetch: gh.fetch,
    ...(now === undefined ? {} : { now }),
  })

test('同时要令牌：只换一次；有效期内复用；离到期不到 5 分钟时换新的', async () => {
  const gh = fakeGitHub()
  let now = Date.now()
  const app = make(gh, () => now)
  const [a, b, c] = await Promise.all([app.token(repo), app.token(repo), app.token(repo)])
  assert.equal(a.token, 'ghs_1')
  assert.deepEqual([b.token, c.token], ['ghs_1', 'ghs_1'])
  assert.equal(gh.calls.filter(x => x.endsWith('access_tokens')).length, 1)
  assert.equal((await app.token(repo)).token, 'ghs_1')
  now = a.expiresAt - REFRESH_BEFORE_MS + 1
  assert.equal((await app.token(repo)).token, 'ghs_2')
})

test('换令牌失败不留在缓存里：下次重新换；没装到仓库时抛 NotInstalled', async () => {
  const gh = fakeGitHub({ failMint: 1 })
  const app = make(gh)
  await assert.rejects(app.token(repo), /换 App 的安装令牌失败（HTTP 500）/)
  assert.equal((await app.token(repo)).token, 'ghs_1')
  const none = make(fakeGitHub({ installed: false }))
  await assert.rejects(none.token(repo), (e: Error) => e instanceof NotInstalled && /没有安装到 acme\/app/.test(e.message))
})

test('凭据里的私钥不是 PEM、读不出来：报中文原因', async () => {
  assert.equal(appCredential.safeParse({ appId: 1, privateKey: 'nope' }).success, false)
  assert.throws(
    () =>
      new GitHubApp({
        apiUrl: 'https://api.github.com',
        credential: appCredential.parse({ appId: 1, privateKey: '-----BEGIN PRIVATE KEY-----\nxx\n-----END PRIVATE KEY-----' }),
        credentialName: 'github-app.github.com',
      }),
    /凭据「github-app\.github\.com」里的私钥读不出来/,
  )
})

test('私钥不是 RSA：报中文原因（签出来的不是 RS256）', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.throws(
    () => new GitHubApp({ apiUrl: 'https://api.github.com', credential: appCredential.parse({ appId: 1, privateKey: ec }), credentialName: 'github-app.github.com' }),
    /私钥是 ec 类型，GitHub App 的私钥应该是 RSA/,
  )
})
