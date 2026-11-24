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
  /** 浏览器里打开这个分支的地址。 */
  branchUrl(repo: RemoteRepo, branch: string): string
  /**
   * 从 head 分支向 base 开一个 PR；head 已经有打开的 PR（不管目标分支是哪个）时复用它（reused 为 true），重复调用不会开出第二个。
   * head 和 base 没有差别时返回 { empty: true }。出错时抛 ForgeError（消息是给用户看的中文）。
   */
  openPullRequest(repo: RemoteRepo, token: string | undefined, p: { head: string; base: string; title: string; body: string }): Promise<PullRequest | { empty: true }>
}

export type PullRequest = { number: number; url: string; reused: boolean }

/** 托管平台的接口出错：消息是给用户看的中文，不含令牌。 */
export class ForgeError extends Error {}
