// 在部署镜像里跑（由 scripts/chat-docker-probe.ts 启动，root）：核对对话 agent 的 MCP 端点对同一容器里别的用户的防护。
// 1. 开一个端点（和对话 agent 每次调用开的一样）；
// 2. 以检查命令的用户 eos-check、agent 的用户 eos-agent 连它：不带令牌、带错的令牌都被拒（401）；带对的令牌能用（说明令牌是唯一的防线）；
// 3. 令牌落在 dsh 的配置文件里（平台写，0644）：eos-check 进不了 dsh home，读不到；eos-agent（dsh 和所有任务的 agent 共用）读得到——已知限制。
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
// 用镜像里的代码（/app），不是挂进来的这份脚本旁边的。
const { openEndpoint } = (await import(String('/app/src/chat/mcp.ts'))) as typeof import('../src/chat/mcp.ts')

const as = (user: string, ...cmd: string[]) =>
  spawnSync('setpriv', [`--reuid=${user}`, `--regid=${execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim()}`, '--init-groups', '--', ...cmd], { encoding: 'utf8' })
const run = promisify(execFile)
/** 以 user 的身份发一个请求，返回 HTTP 状态码。异步：端点在本进程里，同步等待会让它没法回复。 */
const status = async (user: string, url: string, auth?: string) => {
  const code = `fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'${auth === undefined ? '' : `,authorization:${JSON.stringify(auth)}`}},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>console.log(r.status)).catch(e=>console.log('ERR '+e.message))`
  const gid = execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim()
  return (await run('setpriv', [`--reuid=${user}`, `--regid=${gid}`, '--init-groups', '--', process.execPath, '-e', code], { encoding: 'utf8', timeout: 30_000 })).stdout.trim()
}

const ep = await openEndpoint({ name: 'eos', tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }], call: () => ({ text: 'ok', isError: false }) })
const results: Record<string, unknown> = {}
for (const user of ['eos-check', 'eos-agent']) {
  results[`${user}: 不带令牌`] = await status(user, ep.mcp.url)
  results[`${user}: 错的令牌`] = await status(user, ep.mcp.url, 'Bearer wrong-token')
}
results['eos-check: 对的令牌（令牌泄露时）'] = await status('eos-check', ep.mcp.url, ep.mcp.headers.Authorization)

// dsh home 按 deploy/eos 的方式准备好（eos doctor 会跑 prepare），再以平台用户写一个和 dsh.ts 一样权限的配置文件。
spawnSync('eos', ['doctor'], { stdio: 'ignore' })
const dir = '/data/dsh/eos-profiles/probe'
as('eos', 'mkdir', '-p', dir)
as('eos', 'sh', '-c', `umask 022; printf 'headers: {Authorization: "${ep.mcp.headers.Authorization}"}\\n' > ${dir}/cordis.patch.yml`)
const read = (user: string) => (as(user, 'cat', `${dir}/cordis.patch.yml`).stdout.includes(ep.mcp.headers.Authorization!) ? '读得到' : '读不到')
results['eos-check: 读 dsh 配置里的令牌'] = read('eos-check')
results['eos-agent: 读 dsh 配置里的令牌'] = read('eos-agent')
results['dsh home 的权限'] = execFileSync('stat', ['-c', '%A %U:%G', '/data/dsh'], { encoding: 'utf8' }).trim()
await ep.close()
results['端点关闭后 eos-agent 带对的令牌'] = await status('eos-agent', ep.mcp.url, ep.mcp.headers.Authorization)
console.log(JSON.stringify(results, null, 2))
