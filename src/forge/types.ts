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
  /** 浏览器里打开这个分支的地址。 */
  branchUrl(repo: RemoteRepo, branch: string): string
  /**
   * 从 head 分支向 base 开一个 PR；head 已经有打开的 PR（不管目标分支是哪个）时复用它（reused 为 true），重复调用不会开出第二个。
   * 这个分支打开的 PR 被关掉（没合并）后再调用，会开一个新的。sha 是刚推上去的提交：它已经通过某个 PR 合并过时返回 { merged }。
   * head 和 base 没有差别时返回 { empty: true }。出错时抛 ForgeError（消息是给用户看的中文）。
   */
  openPullRequest(repo: RemoteRepo, token: string | undefined, p: { head: string; base: string; sha: string; title: string; body: string; credential?: string }): Promise<PullRequest | { empty: true } | { merged: { number: number; url: string } }>
}

export type PullRequest = { number: number; url: string; reused: boolean }

/** 托管平台的接口出错：消息是给用户看的中文，不含令牌。 */
export class ForgeError extends Error {}

/** 托管平台的 App 没装到这个仓库：调用方据此退回个人访问令牌或匿名访问。 */
export class NotInstalled extends ForgeError {}
