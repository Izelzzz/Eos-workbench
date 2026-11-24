// 各验证脚本共用：数据目录、agent 进程的环境、会话 id、跑一轮、记结论。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { MOCK, startUpstream } from './upstream.ts'

export { MOCK }
export const MODEL = process.env.EOS_MODEL ?? 'claude-sonnet-5-5'
const DATA = resolve(process.env.POC ?? '.run')

/** 一个验证用例的目录：home（agent 的 HOME）和 ws（任务 worktree，git 仓库）。都在平台数据目录下，不在 /tmp。 */
export const dirs = (name: string, fresh = true) => {
  const root = join(DATA, name), home = join(root, 'home'), ws = join(root, 'ws')
  if (fresh) rmSync(root, { recursive: true, force: true })
  mkdirSync(home, { recursive: true }); mkdirSync(ws, { recursive: true })
  if (fresh) execFileSync('git', ['init', '-q', ws])
  return { root, home, ws }
}

/** 会话 id 由平台的 key 确定性算出（SDK 要求 UUID 格式），崩溃后总能找回同一个会话。 */
export const sessionIdFor = (key: string): string => {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export const marker = (nonce: string) => `<!-- eos:${nonce} -->`

const upstream = await startUpstream()
export const closeUpstream = upstream.close

/**
 * agent 进程的全部环境变量：不继承宿主进程的环境。凭据不在这里：上游代理转发时才加上。
 * EOS_AUTH=oauth 时 Claude Code 走订阅令牌的认证路径，令牌同样是假的，由代理替换。
 */
export const agentEnv = (home: string, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: home,
  LANG: 'C.UTF-8',
  ANTHROPIC_BASE_URL: upstream.url,
  ...(process.env.EOS_AUTH === 'oauth' ? { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-eos-placeholder' } : { ANTHROPIC_API_KEY: 'sk-ant-eos-placeholder' }),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  ...extra,
})

/** 平台给每个会话的基础选项：不读任何设置文件，模型固定。各脚本在此基础上加权限和工具。 */
export const baseOptions = (home: string, ws: string): Options => ({
  cwd: ws,
  env: agentEnv(home),
  model: MODEL,
  settingSources: [],
  stderr: d => { if (process.env.EOS_DEBUG) process.stderr.write(d) },
})

export type Turn = { messages: SDKMessage[]; result?: Extract<SDKMessage, { type: 'result' }>; init?: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>; error?: string }

/** 跑一轮（一个 query），收集所有消息。 */
export const run = async (prompt: string, options: Options, onMessage?: (m: SDKMessage) => void): Promise<Turn> => {
  const t: Turn = { messages: [] }
  try {
    for await (const m of query({ prompt, options })) {
      t.messages.push(m)
      if (m.type === 'system' && m.subtype === 'init') t.init = m as Turn['init']
      if (m.type === 'result') t.result = m as Turn['result']
      onMessage?.(m)
    }
  } catch (e) {
    t.error = (e as Error).message
  }
  return t
}

/** 一轮里 assistant 发起的工具调用（名字和参数）。 */
export const toolUses = (t: Turn) => t.messages.flatMap(m => m.type === 'assistant' ? ((m as any).message.content as any[]).filter(c => c.type === 'tool_use') : [])
/** 一轮里的工具结果（tool_use_id → 是否出错、内容）。 */
export const toolResults = (t: Turn) => t.messages.flatMap(m => m.type === 'user' && Array.isArray((m as any).message.content) ? ((m as any).message.content as any[]).filter(c => c.type === 'tool_result') : [])
  .map(c => ({ id: c.tool_use_id as string, isError: c.is_error === true, text: typeof c.content === 'string' ? c.content : (c.content ?? []).map((x: any) => x.text ?? '').join('') }))
export const finalText = (t: Turn) => (t.result as any)?.result as string | undefined

let failed = 0
/** 记一条结论：PASS / FAIL 加上证据。脚本最后用 done() 以失败数作为退出码。 */
export const check = (name: string, ok: boolean, evidence: unknown) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`)
}
/** 只记录观察到的事实，不判断通过与否。 */
export const note = (name: string, evidence: unknown) => console.log(`NOTE ${name} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`)
export const done = () => { upstream.close(); console.log(`mode=${MOCK ? 'mock' : 'real'} model=${MODEL} failed=${failed}`); process.exit(failed ? 1 : 0) }
