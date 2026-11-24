// GitHub：仓库地址的写法、令牌的名字、git 的认证头、开 PR。
import { z } from 'zod'
import { ForgeError, type Forge, type PullRequest, type RemoteRepo } from './types.ts'

/** 一次 API 请求最多等这么久。 */
const API_TIMEOUT_MS = 60_000

const pull = z.object({ number: z.number().int(), html_url: z.string().url() })
const apiError = z.object({ message: z.string().optional(), errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional() }).passthrough()

/** GitHub 的报错换成中文原因；body 是它返回的 JSON（解析不了时是 undefined）。 */
const explainApi = (repo: RemoteRepo, status: number, body: unknown, credential: string, hasToken: boolean): string => {
  const e = apiError.safeParse(body).data
  const said = [e?.message, ...(e?.errors ?? []).map(x => x.message)].filter((x): x is string => typeof x === 'string' && x !== '').join('；')
  const where = `${repo.host} 上的 ${repo.owner}/${repo.name}`
  if (status === 401) return `${repo.host} 拒绝了令牌：凭据「${credential}」${hasToken ? '里的令牌无效或已过期' : '不存在，开 PR 需要令牌'}。在凭据页添加或替换这条凭据`
  if (status === 403) return `${repo.host} 不允许在 ${where} 开 PR：令牌没有 Pull requests 的写权限，或者被限流了（${said || status}）`
  if (status === 404) return `找不到仓库 ${where}，或者凭据「${credential}」里的令牌看不到它`
  return `在 ${where} 开 PR 失败（HTTP ${status}）：${said || '没有说明'}`
}

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const NAME = '[A-Za-z0-9._-]{1,100}'

/**
 * host 默认 github.com；自建的 GitHub Enterprise 传它的域名。scheme 只在测试里用 http（本地的 git 服务）。
 * 认的写法：https://<host>/<owner>/<repo>（可以带 .git 或末尾的 /，也可以省略 https://），以及 git@<host>:<owner>/<repo>.git（换成 HTTPS 访问）。
 */
export const githubForge = (o: { host?: string; scheme?: 'https' | 'http' } = {}): Forge => {
  const host = (o.host ?? 'github.com').toLowerCase()
  const scheme = o.scheme ?? 'https'
  // github.com 的 API 在 api.github.com；GitHub Enterprise 在 /api/v3。
  const api = host === 'github.com' ? 'https://api.github.com' : `${scheme}://${host}/api/v3`
  const call = async (repo: RemoteRepo, token: string | undefined, credential: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> => {
    let res: Response
    try {
      res = await fetch(`${api}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${path}`, {
        method: init.method ?? 'GET',
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'eos-workbench', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      })
    } catch (e) {
      throw new ForgeError(`连不上 ${new URL(api).host}：${(e as Error).message}`)
    }
    const text = await res.text()
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }
    if (!res.ok && !(res.status === 422 && init.method === 'POST')) throw new ForgeError(explainApi(repo, res.status, body, credential, token !== undefined))
    return { status: res.status, body }
  }
  const h = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const https = new RegExp(`^(?:${scheme}://)?${h}/(${OWNER})/(${NAME}?)(?:\\.git)?/?$`, 'i')
  const ssh = new RegExp(`^git@${h}:(${OWNER})/(${NAME}?)(?:\\.git)?$`, 'i')
  return {
    kind: 'github',
    parse(input: string): RemoteRepo | undefined {
      const m = https.exec(input.trim()) ?? ssh.exec(input.trim())
      const [owner, name] = [m?.[1], m?.[2]]
      if (owner === undefined || name === undefined || name === '.' || name === '..' || name.endsWith('.git')) return undefined
      const base = `${scheme}://${host}/${owner}/${name}`
      return { forge: 'github', host, owner, name, cloneUrl: `${base}.git`, webUrl: base }
    },
    credentialName: repo => repo.host,
    // 个人访问令牌和 GitHub App 的安装令牌都可以用 x-access-token 作用户名。
    gitAuthHeader: token => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    async openPullRequest(repo, token, p): Promise<PullRequest | { empty: true }> {
      const credential = repo.host
      // 同一个分支已经有打开的 PR：复用它（重试、崩溃后重跑时不会开出第二个）。
      const existing = await call(repo, token, credential, `/pulls?state=open&head=${encodeURIComponent(`${repo.owner}:${p.head}`)}&base=${encodeURIComponent(p.base)}`)
      const list = z.array(pull).safeParse(existing.body)
      if (!list.success) throw new ForgeError(`${repo.host} 返回的 PR 列表格式不对`)
      if (list.data[0] !== undefined) return { number: list.data[0].number, url: list.data[0].html_url, reused: true }
      const created = await call(repo, token, credential, '/pulls', { method: 'POST', body: { title: p.title, head: p.head, base: p.base, body: p.body } })
      if (created.status === 422) {
        const said = JSON.stringify(created.body ?? '')
        if (/No commits between/i.test(said)) return { empty: true }
        throw new ForgeError(explainApi(repo, 422, created.body, credential, token !== undefined))
      }
      const pr = pull.safeParse(created.body)
      if (!pr.success) throw new ForgeError(`${repo.host} 返回的 PR 格式不对`)
      return { number: pr.data.number, url: pr.data.html_url, reused: false }
    },
    branchUrl: (repo, branch) => `${repo.webUrl}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`,
  }
}
