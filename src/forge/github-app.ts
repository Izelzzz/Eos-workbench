// GitHub App：用 App 的私钥签 JWT，换一个只对这个仓库有效的安装令牌（GitHub 给 1 小时），快过期时自动换新的。
// - App 的凭据（id 和私钥）存在凭据存储里，类型是 github-app，名字是 github-app.<主机>；只在平台进程里用。
// - 安装令牌只放在内存缓存里，不落盘；到期前 REFRESH_BEFORE_MS 就换新的，正在用的 git 进程不会拿到快过期的令牌。
// - 查安装用 GET /repos/<owner>/<repo>/installation：App 没装到这个仓库时 GitHub 返回 404，调用方退回别的认证方式。
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto'
import { z } from 'zod'
import { ForgeError, NotInstalled, type AppRegistration, type RemoteRepo } from './types.ts'

/** 凭据存储里 github-app 凭据的值：JSON。slug 用来给出"安装到仓库"的地址（清单流程注册时拿到）。 */
export const appCredential = z
  .object({
    appId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
    privateKey: z.string().includes('PRIVATE KEY', { message: '不是 PEM 格式的私钥' }),
    slug: z.string().optional(),
    /** App 在托管平台上的页面（清单流程注册时拿到），安装页在它下面。GitHub Enterprise 的路径和 github.com 不同，所以记下原样的地址。 */
    htmlUrl: z.string().url().optional(),
    /** 用户授权（OAuth）用的 client id 和 secret（清单流程注册时拿到）。早先注册的 App 没有，要重新注册才能用用户授权。 */
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    /** 注册时写进 App 的用户授权回调地址：GitHub 只认这个地址，用别的地址打开平台发起授权会被 GitHub 拒绝。 */
    userCallbackUrl: z.string().url().optional(),
  })
  .passthrough()
export type AppCredential = z.infer<typeof appCredential>

/** github-app 凭据的名字。 */
export const appCredentialName = (host: string): string => `github-app.${host}`

/** 安装令牌在到期前这么久就换新的：git clone/fetch 可能跑上好几分钟。 */
export const REFRESH_BEFORE_MS = 5 * 60 * 1000

const API_TIMEOUT_MS = 60_000
const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

/** GitHub 要求的 App JWT：RS256，iat 往前拨 60 秒容忍时钟误差，10 分钟内有效（GitHub 的上限）。 */
export const appJwt = (appId: string, key: KeyObject, nowMs: number): string => {
  const iat = Math.floor(nowMs / 1000) - 60
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }))
  const sign = createSign('RSA-SHA256')
  sign.update(`${head}.${body}`)
  return `${head}.${body}.${b64url(sign.sign(key))}`
}

const installation = z.object({ id: z.number().int() })
const accessToken = z.object({ token: z.string().min(1), expires_at: z.string() })

type Cached = { token: string; expiresAt: number }

/**
 * 一个 App（按主机）的安装令牌来源。apiUrl 是 GitHub API 的根地址；now 可以注入（测试用）。
 * 同一个仓库在令牌有效期内重复要令牌，只换一次；并发的请求共用同一次换取。
 */
export class GitHubApp {
  private readonly key: KeyObject
  private readonly cache = new Map<string, Promise<Cached>>()

  constructor(private readonly o: { apiUrl: string; credential: AppCredential; credentialName: string; now?: () => number; fetch?: typeof fetch }) {
    try {
      this.key = createPrivateKey(o.credential.privateKey)
    } catch (e) {
      throw new ForgeError(`凭据「${o.credentialName}」里的私钥读不出来：${(e as Error).message}`)
    }
    // GitHub App 的私钥是 RSA；别的类型签出来的不是 RS256，GitHub 只会回一句 401。
    if (this.key.asymmetricKeyType !== 'rsa') throw new ForgeError(`凭据「${o.credentialName}」里的私钥是 ${this.key.asymmetricKeyType ?? '未知'} 类型，GitHub App 的私钥应该是 RSA`)
  }

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  private async call(path: string, auth: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    let res: Response
    let text: string
    try {
      res = await (this.o.fetch ?? fetch)(`${this.o.apiUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'eos-workbench',
          authorization: auth,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
      text = await res.text()
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      throw new ForgeError(
        `访问 ${new URL(this.o.apiUrl).host} 失败：${[err.name === 'TimeoutError' ? `${API_TIMEOUT_MS / 1000} 秒没有响应` : err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join('：')}`,
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

  /** 作废这个仓库缓存的令牌：用它访问被拒（App 被卸载重装、改了权限）时，下次重新换。 */
  forget(repo: RemoteRepo): void {
    this.cache.delete(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`)
  }

  /** 这个仓库的安装令牌；App 没装到这个仓库时抛 NotInstalled，别的错误抛 ForgeError（中文原因）。 */
  token(repo: RemoteRepo): Promise<Cached> {
    const key = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`
    const hit = this.cache.get(key)
    const fresh = hit?.then(
      c => (c.expiresAt - REFRESH_BEFORE_MS > this.now() ? c : undefined),
      () => undefined,
    )
    const next = (fresh ?? Promise.resolve(undefined)).then(c => c ?? this.mint(repo))
    this.cache.set(key, next)
    // 换取失败不留在缓存里：下次重新换。
    next.catch(() => {
      if (this.cache.get(key) === next) this.cache.delete(key)
    })
    return next
  }

  private async mint(repo: RemoteRepo): Promise<Cached> {
    const name = this.o.credentialName
    const jwt = `Bearer ${appJwt(this.o.credential.appId, this.key, this.now())}`
    const where = `${repo.owner}/${repo.name}`
    const inst = await this.call(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`, jwt)
    if (inst.status === 404) {
      const install = this.o.credential.slug === undefined ? '' : `：到 https://${repo.host}/apps/${this.o.credential.slug}/installations/new 把它安装到这个仓库`
      throw new NotInstalled(`凭据「${name}」的 GitHub App 没有安装到 ${where}${install}`)
    }
    if (inst.status === 401) throw new ForgeError(`${repo.host} 不认凭据「${name}」的 App：App id 或私钥不对（私钥可能已被撤销）`)
    const id = installation.safeParse(inst.body).data?.id
    if (inst.status !== 200 || id === undefined) throw new ForgeError(`查 App 在 ${where} 的安装失败（HTTP ${inst.status}）`)
    // 令牌只授权这一个仓库：别的仓库即使也装了这个 App，这个令牌也访问不到。
    const got = await this.call(`/app/installations/${id}/access_tokens`, jwt, { method: 'POST', body: { repositories: [repo.name] } })
    const parsed = accessToken.safeParse(got.body).data
    if (got.status !== 201 || parsed === undefined) {
      throw new ForgeError(
        got.status === 403 || got.status === 422
          ? `App 在 ${where} 的安装没有授权这个仓库、缺少权限，或者仓库改过名（HTTP ${got.status}）：在 App 的安装设置里勾选这个仓库，并给 Contents 读写、Pull requests 读写；仓库改过名时，用 GitHub 上现在的地址建任务`
          : `换 App 的安装令牌失败（HTTP ${got.status}）`,
      )
    }
    const expiresAt = Date.parse(parsed.expires_at)
    if (Number.isNaN(expiresAt)) throw new ForgeError(`${repo.host} 返回的令牌到期时间不对：${parsed.expires_at}`)
    return { token: parsed.token, expiresAt }
  }
}

/** App 的安装页：在 App 页面地址下面；老凭据没有页面地址时按 github.com 的路径用短名拼。 */
const installUrlOf = (web: string, c: AppCredential): string | undefined =>
  c.htmlUrl !== undefined ? `${c.htmlUrl.replace(/\/$/, '')}/installations/new` : c.slug === undefined ? undefined : `${web}/apps/${encodeURIComponent(c.slug)}/installations/new`

/** App 名字的上限（GitHub 的限制）。 */
export const APP_NAME_MAX = 34
const conversion = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1),
  pem: z.string(),
  html_url: z.string().url(),
  name: z.string().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
})

/**
 * 清单流程注册 GitHub App（https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest）。
 * web 是浏览器访问 GitHub 的根地址（https://github.com），api 是 API 的根地址。
 * App 的权限只要平台用到的：Contents 读写（推任务分支）、Pull requests 读写（开 PR）、Metadata 只读（GitHub 必带）。
 * callback_urls 是用户授权（OAuth）完跳回的地址：平台以授权人的身份推送、开 PR 时用。
 * 不带 hook_attributes：平台不收 webhook；带上时 GitHub 会检查它的地址，本机地址注册不了。
 */
export const githubAppRegistration = (o: { host: string; web: string; api: string; fetch?: typeof fetch }): AppRegistration => ({
  credentialName: appCredentialName(o.host),
  host: o.host,
  appNameMax: APP_NAME_MAX,
  form: p => {
    const manifest = {
      name: p.appName,
      url: p.origin,
      redirect_url: p.callbackUrl,
      callback_urls: [p.userCallbackUrl],
      public: false,
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      default_events: [],
    }
    const where = p.org === undefined ? '/settings/apps/new' : `/organizations/${encodeURIComponent(p.org)}/settings/apps/new`
    return { action: `${o.web}${where}?state=${encodeURIComponent(p.state)}`, fields: { manifest: JSON.stringify(manifest) } }
  },
  complete: async (code, p) => {
    let res: Response
    let text: string
    try {
      // 换凭据的接口不需要认证：code 本身就是凭证（一小时内有效，只能用一次）。
      res = await (o.fetch ?? fetch)(`${o.api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'eos-workbench' },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
      text = await res.text()
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } }
      throw new ForgeError(
        `访问 ${new URL(o.api).host} 失败：${[err.name === 'TimeoutError' ? `${API_TIMEOUT_MS / 1000} 秒没有响应` : err.message, err.cause?.code ?? err.cause?.message].filter(Boolean).join('：')}`,
      )
    }
    if (res.status === 404 || res.status === 422) throw new ForgeError(`${o.host} 不认这次注册返回的 code（一小时内有效，只能用一次）：重新注册一次`)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    // 返回的内容里有私钥和 client secret：报错里不写响应内容。
    const got = conversion.safeParse(body).data
    if (res.status !== 201 || got === undefined) throw new ForgeError(`换 App 凭据失败（HTTP ${res.status}）`)
    // 只留平台用得到的：App id、私钥、短名、页面地址，以及用户授权要用的 client id 和 secret。webhook secret 用不到，不存。
    const parsed = appCredential.safeParse({
      appId: got.id,
      privateKey: got.pem,
      slug: got.slug,
      htmlUrl: got.html_url,
      clientId: got.client_id,
      clientSecret: got.client_secret,
      userCallbackUrl: p.userCallbackUrl,
    })
    if (!parsed.success) throw new ForgeError(`${o.host} 返回的 App 凭据格式不对（${parsed.error.issues.map(i => i.path.join('.')).join('、')}）：在 ${got.html_url} 删掉这个 App 后重新注册`)
    // 私钥要能签名：读不出来或不是 RSA 时这里就报错，不存一条用不了的凭据。
    try {
      new GitHubApp({ apiUrl: o.api, credential: parsed.data, credentialName: appCredentialName(o.host) })
    } catch (e) {
      throw new ForgeError(`${(e as Error).message}：在 ${got.html_url} 删掉这个 App 后重新注册`)
    }
    return { value: JSON.stringify(parsed.data), appName: got.name ?? got.slug, appUrl: got.html_url, installUrl: installUrlOf(o.web, parsed.data) }
  },
  installUrl: value => {
    try {
      const c = appCredential.safeParse(JSON.parse(value)).data
      return c === undefined ? undefined : installUrlOf(o.web, c)
    } catch {
      return undefined
    }
  },
})
