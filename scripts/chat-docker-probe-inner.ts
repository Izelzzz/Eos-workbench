// 在部署镜像里跑（由 scripts/chat-docker-probe.ts 启动，root）。不调真实模型。
// 1. 端点：开一个和对话 agent 每次调用一样的端点，以检查命令的用户 eos-check、agent 的用户 eos-agent 连它：
//    不带令牌、带错的令牌都被拒（401）；带对的令牌能用（令牌是唯一的防线）；端点关掉后连不上。
// 2. 真实链路：容器里起假模型，经 eos 入口跑 `eos chat new`（平台以 eos 运行，dsh 以 eos-agent 运行）。
//    调用进行中看 DshExecutor 写出的带令牌配置：权限、属主和组，eos-check 和 eos-agent 能不能读；调用结束后核对配置删掉了、对话有回复。
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

// 用镜像里的代码（/app），不是挂进来的这份脚本旁边的。
const { openEndpoint } = (await import(String('/app/src/chat/mcp.ts'))) as typeof import('../src/chat/mcp.ts')
const { startFakeModel } = (await import(String('/app/scripts/fake-model/server.ts'))) as typeof import('./fake-model/server.ts')
type Request = import('./fake-model/script.ts').Request

const run = promisify(execFile)
const gidOf = (user: string) => execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim()
/** 以 user 的身份运行（异步：端点和假模型都在本进程里，同步等待会让它们没法回复）。 */
const as = async (user: string, ...cmd: string[]) => {
  try {
    return (await run('setpriv', [`--reuid=${user}`, `--regid=${gidOf(user)}`, '--init-groups', '--', ...cmd], { encoding: 'utf8', timeout: 30_000 })).stdout.trim()
  } catch (e) {
    return `ERR ${
      String((e as { stderr?: string }).stderr ?? (e as Error).message)
        .trim()
        .split('\n')[0]
    }`
  }
}
const status = (user: string, url: string, auth?: string) =>
  as(
    user,
    process.execPath,
    '-e',
    `fetch(${JSON.stringify(url)},{method:'POST',headers:{'content-type':'application/json'${auth === undefined ? '' : `,authorization:${JSON.stringify(auth)}`}},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).then(r=>console.log(r.status)).catch(e=>console.log('ERR '+e.message))`,
  )

const results: Record<string, unknown> = {}

// 1. 端点
const ep = await openEndpoint({ name: 'eos', tools: [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }], call: () => ({ text: 'ok', isError: false }) })
for (const user of ['eos-check', 'eos-agent']) {
  results[`${user}: 不带令牌`] = await status(user, ep.mcp.url)
  results[`${user}: 错的令牌`] = await status(user, ep.mcp.url, 'Bearer wrong-token')
}
results['eos-check: 对的令牌（令牌泄露时）'] = await status('eos-check', ep.mcp.url, ep.mcp.headers.Authorization)
await ep.close()
results['端点关闭后 eos-agent 带对的令牌'] = await status('eos-agent', ep.mcp.url, ep.mcp.headers.Authorization)

// 2. 真实链路：假模型先让 agent 列工作流，再回答。
const model = await startFakeModel(
  () => {},
  (req: Request) => {
    const done = req.messages.at(-1)!.content.some(b => b.type === 'tool_result')
    return done ? { kind: 'text', text: '读到了工作流列表' } : { kind: 'tool', name: 'mcp__eos__list_conventions', input: { kind: 'workflow' } }
  },
)
const root = '/data/dsh/eos-profiles/ephemeral'
const seen: Record<string, unknown>[] = []
let watching = true
const watch = (async () => {
  while (watching) {
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      const dir = join(root, name)
      const file = join(dir, 'cordis.patch.yml')
      if (seen.length > 0 || !existsSync(file)) continue
      const st = (p: string) => {
        const s = statSync(p)
        return `${(s.mode & 0o7777).toString(8)} ${execFileSync('stat', ['-c', '%U:%G', p], { encoding: 'utf8' }).trim()}`
      }
      const token = /Bearer [A-Za-z0-9_-]+/.exec(readFileSync(file, 'utf8'))?.[0] ?? ''
      const readable = async (user: string) => ((await as(user, 'cat', file)).includes(token) && token !== '' ? '读得到' : '读不到')
      seen.push({ dir: st(dir), file: st(file), 'eos-check': await readable('eos-check'), 'eos-agent': await readable('eos-agent') })
    }
    await new Promise(r => setTimeout(r, 50))
  }
})()
const env = { ...process.env, EOS_MODEL_BASE_URL: model.baseUrl, DEEPSEEK_API_KEY: 'fake-model-key-0123456789', EOS_MASTER_KEY: Buffer.alloc(32, 9).toString('base64') }
let chat: string
try {
  chat = (await run('eos', ['chat', 'new', '平台上有哪些工作流？'], { env, encoding: 'utf8', timeout: 300_000 })).stdout
} catch (e) {
  const x = e as { stdout?: string; stderr?: string }
  chat = `ERR ${x.stdout ?? ''}${x.stderr ?? ''}`
}
watching = false
await watch
await model.close()
results['eos chat new 的回复'] = chat.includes('读到了工作流列表') ? '有回复' : chat.slice(-800)
results['调用期间带令牌的配置'] = seen[0] ?? '没看到'
results['调用结束后 ephemeral 里剩下的'] = existsSync(root) ? readdirSync(root) : []
results['dsh home 的权限'] = execFileSync('stat', ['-c', '%A %U:%G', '/data/dsh'], { encoding: 'utf8' }).trim()
console.log(JSON.stringify(results, null, 2))
