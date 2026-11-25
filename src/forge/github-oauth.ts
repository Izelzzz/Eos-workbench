// GitHub App 的用户授权（OAuth）：一个人在 GitHub 上授权给平台的 App，平台拿到代表这个人的用户令牌，以他的身份推送、开 PR。
// - 用户令牌只能访问「App 装到了、而且这个人有权限」的仓库，权限不超过 App 申请的权限。
// - App 开着"用户令牌过期"（新注册的 App 默认开）时，令牌 8 小时过期，带一个刷新令牌（半年）；每次刷新都会换一个新的刷新令牌，旧的作废。
// - 用到的 client id 和 secret 在 App 凭据里（清单流程注册时拿到）。
// 文档：https://docs.github.com/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
import { z } from 'zod'
import { appCredential, appCredentialName, REFRESH_BEFORE_MS } from './github-app.ts'
import { ForgeError, type UserAuthorization } from './types.ts'

const API_TIMEOUT_MS = 60_000

/** 凭据存储里 github-user 凭据的值。时间都是毫秒时间戳；没有 expiresAt 表示令牌不过期（App 关了令牌过期）。 */
export const userCredential = z.object({
  login: z.string().min(1),
  accessToken: z.string().min(1),
  expiresAt: z.number().optional(),
  refreshToken: z.string().min(1).optional(),
  refreshExpiresAt: z.number().optional(),
})
export type UserCredential = z.infer<typeof userCredential>

export const userCredentialName = (host: string): string => `github-user.${host}`

/** 换令牌接口的回复：成功时有 access_token，失败时 GitHub 也回 200，带 error 和 error_description。 */
const tokenReply = z.union([
  z.object({ access_token: z.string().min(1), expires_in: z.number().optional(), refresh_token: z.string().min(1).optional(), refresh_token_expires_in: z.number().optional() }),
  z.object({ error: z.string(), error_description: z.string().optional() }),
])
const user = z.object({ login: z.string().min(1) })

export const githubUserAuthorization = (o: { host: string; web: string; api: string; fetch?: typeof fetch }): UserAuthorization => {
  const name = userCredentialName(o.host)
  const appName = appCredentialName(o.host)

  /** App 凭据里的 client id 和 secret；早先注册的 App 没有，要重新注册。 */
  const client = (app: string): { id: string; secret: string; callback?: string } => {
    let parsed: ReturnType<typeof appCredential.safeParse>
    try {
      parsed = appCredential.safeParse(JSON.parse(app))
    } catch {
      throw new ForgeError(`凭据「${appName}」不是 GitHub App 的凭据`)
    }
    const c = parsed.data
    if (c?.clientId === undefined || c.clientSecret === undefined) throw new ForgeError(`凭据「${appName}」的 App 没有记下 client id 和 secret（是早先注册的）：在凭据页删掉它，在代码托管页重新注册`)
    return { id: c.clientId, secret: c.clientSecret, ...(c.userCallbackUrl === undefined ? {} : { callback: c.userCallbackUrl }) }
  }

  const call = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }> => {
    let res: Response
    let text: string
    try {
      res = await (o.fetch ?? fetch)(url, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'eos-workbench',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
      text = await res.text()
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      throw new ForgeError(
        `访问 ${new URL(url).host} 失败：${[err.name === 'TimeoutError' ? `${API_TIMEOUT_MS / 1000} 秒没有响应` : err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join('：')}`,
      )
    }
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }
    return { status: res.status, body }
  }

  /** 换令牌（code 或刷新令牌），返回新的令牌和到期时间。报错里不写回复内容（里面可能有令牌）。 */
  const token = async (app: string, grant: Record<string, string>, now: number, doing: string): Promise<Omit<UserCredential, 'login'>> => {
    const c = client(app)
    const got = await call(`${o.web}/login/oauth/access_token`, { method: 'POST', body: { client_id: c.id, client_secret: c.secret, ...grant } })
    const parsed = tokenReply.safeParse(got.body).data
    if (parsed === undefined) throw new ForgeError(`${doing}失败（HTTP ${got.status}）`)
    if ('error' in parsed) {
      if (parsed.error === 'bad_refresh_token' || parsed.error === 'bad_verification_code') throw new ForgeError(`${doing}失败：GitHub 说授权已失效或过期（${parsed.error}）。在代码托管页重新授权`)
      if (parsed.error === 'incorrect_client_credentials')
        throw new ForgeError(`${doing}失败：GitHub 不认凭据「${appName}」里的 client id 或 secret（App 的 secret 可能被重置了）。在凭据页删掉它，在代码托管页重新注册`)
      throw new ForgeError(`${doing}失败：${parsed.error}${parsed.error_description === undefined ? '' : `（${parsed.error_description}）`}`)
    }
    return {
      accessToken: parsed.access_token,
      ...(parsed.expires_in === undefined ? {} : { expiresAt: now + parsed.expires_in * 1000 }),
      ...(parsed.refresh_token === undefined ? {} : { refreshToken: parsed.refresh_token }),
      ...(parsed.refresh_token_expires_in === undefined ? {} : { refreshExpiresAt: now + parsed.refresh_token_expires_in * 1000 }),
    }
  }

  const read = (value: string): UserCredential => {
    let parsed: ReturnType<typeof userCredential.safeParse>
    try {
      parsed = userCredential.safeParse(JSON.parse(value))
    } catch {
      throw new ForgeError(`凭据「${name}」不是 GitHub 的用户授权：在代码托管页重新授权`)
    }
    if (!parsed.success) throw new ForgeError(`凭据「${name}」不是有效的 GitHub 用户授权：在代码托管页重新授权`)
    return parsed.data
  }

  return {
    credentialName: name,
    authorizeUrl: (app, p) => {
      const c = client(app)
      // GitHub 只认注册时写进 App 的回调地址：地址不一样时 GitHub 停在它的报错页，这里先说清楚。
      if (c.callback !== undefined && c.callback !== p.callbackUrl) {
        throw new ForgeError(`App 只接受授权完跳回 ${c.callback}：用 ${new URL(c.callback).origin} 打开平台后再授权（换了访问地址时，删掉 App 凭据后重新注册）`)
      }
      const q = new URLSearchParams({ client_id: c.id, redirect_uri: p.callbackUrl, state: p.state })
      return `${o.web}/login/oauth/authorize?${q}`
    },
    complete: async (app, p, now) => {
      const t = await token(app, { code: p.code, redirect_uri: p.callbackUrl }, now, '用授权码换令牌')
      const me = await call(`${o.api}/user`, { headers: { authorization: `Bearer ${t.accessToken}` } })
      const login = user.safeParse(me.body).data?.login
      if (me.status !== 200 || login === undefined) throw new ForgeError(`查授权人的账号失败（HTTP ${me.status}）`)
      return { value: JSON.stringify({ login, ...t } satisfies UserCredential), login }
    },
    read: (value, now) => {
      const c = read(value)
      return { login: c.login, token: c.accessToken, refresh: c.expiresAt !== undefined && c.expiresAt - REFRESH_BEFORE_MS <= now, ...(c.expiresAt === undefined ? {} : { expiresAt: c.expiresAt }) }
    },
    refresh: async (app, value, now) => {
      const c = read(value)
      if (c.refreshToken === undefined || (c.refreshExpiresAt !== undefined && c.refreshExpiresAt <= now)) throw new ForgeError(`@${c.login} 的 GitHub 授权已过期：在代码托管页重新授权`)
      const t = await token(app, { grant_type: 'refresh_token', refresh_token: c.refreshToken }, now, `续期 @${c.login} 的 GitHub 授权`)
      return JSON.stringify({ login: c.login, ...t } satisfies UserCredential)
    },
    revoke: async (app, value) => {
      const c = client(app)
      const u = read(value)
      const got = await call(`${o.api}/applications/${encodeURIComponent(c.id)}/grant`, {
        method: 'DELETE',
        headers: { authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}` },
        body: { access_token: u.accessToken },
      })
      // 404：令牌已经失效（过期、在 GitHub 上撤销过），授权也就没了。
      if (got.status !== 204 && got.status !== 404) throw new ForgeError(`在 GitHub 上撤销授权失败（HTTP ${got.status}）`)
    },
  }
}
