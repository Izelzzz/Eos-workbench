// 代码托管平台（GitHub，以后的 GitLab 等）的接口。平台别的地方只认这里的类型，不写死某一家。

/**
 * 托管平台上的一个仓库。cloneUrl 是 HTTPS 克隆地址，不含任何凭据；webUrl 是浏览器里打开的页面。
 * forge 是托管平台的种类（例如 github），host 是它的主机名（github.com，或自建实例的域名）。
 */
export type RemoteRepo = { forge: string; host: string; owner: string; name: string; cloneUrl: string; webUrl: string }

export interface Forge {
  readonly kind: string
  /** 认出这家托管平台的仓库地址；认不出返回 undefined。 */
  parse(input: string): RemoteRepo | undefined
  /** 访问这个仓库用的令牌在凭据存储里的名字。 */
  credentialName(repo: RemoteRepo): string
  /** git 走 HTTPS 时带的认证头（整行，例如 "Authorization: Basic …"）。 */
  gitAuthHeader(token: string): string
  /** 托管平台 App（例如 GitHub App）的凭据在凭据存储里的名字；不支持 App 时没有。 */
  appCredentialName?(repo: RemoteRepo): string
  /**
   * 用 App 的凭据换一个能访问这个仓库的短期令牌（同一个仓库在有效期内重复调用只换一次）。
   * App 没装到这个仓库时抛 NotInstalled，别的错误抛 ForgeError。
   */
  appToken?(repo: RemoteRepo, credential: { name: string; value: string }): Promise<string>
  /** 作废这个仓库缓存的 App 令牌：用它访问被拒时调用，下次重新换（App 被卸载重装、改了权限之后不用等令牌过期）。 */
  forgetAppToken?(repo: RemoteRepo): void
  /** 用清单流程注册托管平台的 App（例如 GitHub App）；不支持时没有。 */
  readonly appRegistration?: AppRegistration
  /** 某个人通过这个 App 授权给平台的用户令牌（OAuth）；不支持时没有。 */
  readonly userAuthorization?: UserAuthorization
  /** 浏览器里打开这个分支的地址。 */
  branchUrl(repo: RemoteRepo, branch: string): string
  /**
   * 从 head 分支向 base 开一个 PR；head 已经有打开的 PR（不管目标分支是哪个）时复用它（reused 为 true），重复调用不会开出第二个。
   * 这个分支打开的 PR 被关掉（没合并）后再调用，会开一个新的。sha 是刚推上去的提交：它已经通过某个 PR 合并过时返回 { merged }。
   * head 和 base 没有差别时返回 { empty: true }。出错时抛 ForgeError（消息是给用户看的中文）。
   */
  openPullRequest(repo: RemoteRepo, token: string | undefined, p: { head: string; base: string; sha: string; title: string; body: string; credential?: string }): Promise<PullRequest | { empty: true } | { merged: { number: number; url: string } }>
}

/**
 * 清单流程注册 App：平台给浏览器一个表单，浏览器提交到托管平台；用户在那里确认后，托管平台带着 code 跳回平台的回调地址，
 * 平台用 code 换回 App 的凭据（id、私钥），存进凭据存储。整个过程平台不需要任何已有的凭据。
 */
export interface AppRegistration {
  /** App 凭据在凭据存储里的名字（按主机，和 appCredentialName 一致）。 */
  readonly credentialName: string
  readonly host: string
  /** App 名字最长多少个字符。 */
  readonly appNameMax: number
  /** 浏览器提交清单用的表单。origin 是浏览器访问平台用的地址，callbackUrl 是注册完跳回的地址，userCallbackUrl 是以后用户授权完跳回的地址，state 原样带回。org 不给时注册在个人账号下。 */
  form(p: { appName: string; origin: string; callbackUrl: string; userCallbackUrl: string; state: string; org?: string }): { action: string; fields: Record<string, string> }
  /** 用回调里的 code 换 App 的凭据：value 是存进凭据存储的值（记下注册时写进 App 的用户授权回调地址 userCallbackUrl）；installUrl 是把 App 安装到仓库的页面。出错时抛 ForgeError。 */
  complete(code: string, p: { userCallbackUrl: string }): Promise<{ value: string; appName: string; appUrl: string; installUrl: string | undefined }>
  /** 已保存的 App 凭据对应的安装页面；凭据里没有记下 App 的短名时没有。 */
  installUrl(value: string): string | undefined
}

/**
 * 用户授权（OAuth）：一个人在托管平台上授权给平台的 App，平台拿到代表这个人的令牌，以他的身份推送、开 PR。
 * 令牌会过期时带着刷新令牌，平台快过期时换新的。app 是 App 凭据的值（里面有 client id 和 secret），user 是用户令牌凭据的值。
 * 出错时抛 ForgeError（消息是给用户看的中文，不含令牌）。
 */
export interface UserAuthorization {
  /** 用户令牌在凭据存储里的名字（按主机）。 */
  readonly credentialName: string
  /** 浏览器去授权的地址。callbackUrl 是授权完跳回的地址，要和注册 App 时写进去的一样，不一样时抛 ForgeError（说明该用哪个地址打开平台）。 */
  authorizeUrl(app: string, p: { callbackUrl: string; state: string }): string
  /** 回调带回的 code 换令牌，并查出授权的人。value 存进凭据存储。 */
  complete(app: string, p: { code: string; callbackUrl: string }, now: number): Promise<{ value: string; login: string }>
  /** 读出令牌和授权的人；refresh 为 true 表示快过期了，用之前先换新的。值不对时抛 ForgeError。 */
  read(user: string, now: number): { login: string; token: string; refresh: boolean; expiresAt?: number }
  /** 这条授权是不是给这个 App 的（删掉 App 重新注册后，旧 App 的授权不能再用）。 */
  matches(app: string, user: string): boolean
  /** 用刷新令牌换新的令牌，返回新的 value（刷新令牌也会换新，旧的作废）。 */
  refresh(app: string, user: string, now: number): Promise<string>
  /** 在托管平台上撤销这次授权。令牌过期了就确认不了（抛 ForgeError）：调用方先续期再撤销。 */
  revoke(app: string, user: string): Promise<void>
}

export type PullRequest = { number: number; url: string; reused: boolean }

/** 托管平台的接口出错：消息是给用户看的中文，不含令牌。 */
export class ForgeError extends Error {}

/** 托管平台的 App 没装到这个仓库：调用方据此退回个人访问令牌或匿名访问。 */
export class NotInstalled extends ForgeError {}
