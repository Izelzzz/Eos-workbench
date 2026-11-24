// GitHub：仓库地址的写法、令牌的名字、git 的认证头。
import type { Forge, RemoteRepo } from './types.ts'

const OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})'
const NAME = '[A-Za-z0-9._-]{1,100}'

/**
 * host 默认 github.com；自建的 GitHub Enterprise 传它的域名。scheme 只在测试里用 http（本地的 git 服务）。
 * 认的写法：https://<host>/<owner>/<repo>（可以带 .git 或末尾的 /，也可以省略 https://），以及 git@<host>:<owner>/<repo>.git（换成 HTTPS 访问）。
 */
export const githubForge = (o: { host?: string; scheme?: 'https' | 'http' } = {}): Forge => {
  const host = (o.host ?? 'github.com').toLowerCase()
  const scheme = o.scheme ?? 'https'
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
    branchUrl: (repo, branch) => `${repo.webUrl}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`,
  }
}
