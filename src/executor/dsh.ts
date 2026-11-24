// dsh 原生 agent 执行器。唯一引用 dsh 的模块。
// - 每个工作目录（任务的 worktree）和模型路由（model + effort）一个 dsh 进程。dsh 在创建会话时把进程的 cwd
//   记成会话的工作区，workspace-write 只允许写这个工作区，之后设工作目录也不会改变它；所以必须按 worktree 分进程，
//   否则可写范围是平台自己的启动目录。任务的 runner 结束时 release 关掉这个 worktree 的进程。
// - dsh 进程自己的工作目录（processCwd）是平台数据目录里的一个空目录，不是 worktree：dsh 启动时会读进程目录下的 .env，
//   worktree 里的 .env（仓库自带的，或开发 agent 写的）不能影响 agent 进程。
// - 续接会话前核对会话头里记录的工作区：不是这个任务的 worktree（例如修复写入范围之前创建的会话）就拒绝续接。
// - 会话 id 由 key 确定性地算出，进程崩溃后总能找回同一个会话。
// - 新会话先设工作目录和权限档位（只读 / 只写工作区），再发第一条消息。
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { stringify as stringifyYaml } from 'yaml'
import type { Usage } from '../engine/types.ts'
import { zeroUsage } from '../engine/types.ts'
import type { DeepSeekHarness as Harness, HarnessSession } from '../../vendor/dsh-sdk-client/index.ts'
import { DeepSeekHarness } from '../../vendor/dsh-sdk-client/index.ts'
import type { DeepSeekHarnessOptions } from '../../vendor/dsh-sdk-client/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ToolGroup } from '../workflow/types.ts'
import type { AgentProfile, AgentQuestion, AgentSpec, AskHandler, Executor, Reply } from './types.ts'

export const PROVIDER = 'deepseek-official'

/**
 * 装在 root/node_modules 里的 dsh：启动文件和版本。没装好（启动文件或 package.json 缺失、读不出版本）时返回 undefined。
 * 启动检查和命令行都从这里拿 dsh 的位置，别的模块不自己拼 dsh 的路径。
 */
export const dshInstall = (root: string): { bin: string; version: string } | undefined => {
  const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  const bin = join(dir, 'lib', 'bin.js')
  try {
    const version: unknown = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: unknown }).version
    return existsSync(bin) && typeof version === 'string' ? { bin, version } : undefined
  } catch {
    return undefined
  }
}
const PRESET: Record<AgentSpec['write'], string> = { none: 'read-only', worktree: 'workspace-write' }

/**
 * 工具组 → dsh 的插件行 id。dsh 只能整行关掉插件，一个能力常常分散在好几行里
 * （子 agent 的派发、fork、控制、团队任务和 workflow 各占一行），所以平台按组限制，不按单个工具名。
 * 每组的映射都由 scripts/template-probe.ts 用真实的 dsh 核对：关掉这些行之后 dsh 还能启动，
 * 这一组的工具从请求头的工具表里消失，别的组的工具还在。工具名见 dsh 的 docs/tool-catalog.md。
 */
export const GROUP_ROWS: Record<ToolGroup, string[]> = {
  web: ['tool-web'],
  subagent: ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-agent-team', 'tool-workflow'],
  bash: ['tool-bash', 'tool-pwsh', 'tool-jobs'],
  schedule: ['tool-schedule'],
  todo: ['tool-todo'],
  goal: ['tool-goal'],
}

/**
 * 每组的那些行提供的工具名。只用来核对映射（探针按它检查工具表），运行时的限制靠 GROUP_ROWS。
 * 这里列的是 tool-catalog 里这些行能提供的全部工具；当前的 dsh 配置不一定都开着
 * （例如 pwsh 只在 Windows 上，interrupt_agent 和 team_task_* 要另外的配置），
 * 探针会把"基线里本来就没有"的工具单独记下来，它们等于没验过。
 */
export const GROUP_TOOLS: Record<ToolGroup, string[]> = {
  web: ['web_fetch', 'web_search'],
  subagent: [
    'subagent', 'subagent_fork', 'list_subagent_models', 'list_agents', 'send_message', 'wait_agent', 'interrupt_agent',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'workflow',
  ],
  bash: ['bash', 'pwsh', 'job_kill', 'job_list', 'job_output'],
  schedule: ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'],
  todo: ['todo_write'],
  goal: ['create_goal', 'get_goal', 'update_goal'],
}

/**
 * 不管角色怎么配都关掉的行：
 * tool-plugin-manager——agent 不能自己装插件，否则它能把平台去掉的工具再装回来；
 * skill-office——sdk profile 自带的 Office 技能，开着的话 agent 会看到模板之外的技能。
 */
export const ALWAYS_DISABLED = ['tool-plugin-manager', 'skill-office']

/**
 * 能力面的指纹。dsh 把工具、技能和 MCP 都按进程配置（profile 补丁），不能按会话配，
 * 所以指纹进进程的路由键：能力面相同的角色共用一个 dsh 进程，不同的各起一个。
 * 技能按名字排序（技能目录是个集合，先后无意义）；MCP 保持模板里的顺序。
 */
export const profileHash = (p: AgentProfile): string =>
  createHash('sha256').update(JSON.stringify([
    [...p.denyTools].sort(),
    [...p.skills].map(s => [s.name, s.content] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    p.mcp.map(m => [m.name, m.command, m.args, Object.entries(m.env).sort()]),
    p.background,
  ])).digest('hex').slice(0, 16)

/**
 * 这个能力面的 profile 补丁（cordis.patch.yml 的内容）。值都是数据，由 yaml 包序列化，不做字符串拼接。
 * skill-filesystem 总是只指向本能力面的技能目录（哪怕一个技能都没有）：includeDefaultRoots 关掉之后，
 * agent 看不到仓库和用户目录里的技能，只看得到模板给它的。
 */
export const patchRows = (p: AgentProfile, skillsDir: string, mcpCwd: string): unknown[] => {
  // 不能起后台作业时：去掉 job_* 工具（tool-jobs）和自带后台运行的 workflow 工具（tool-workflow），bash 不接受 run_in_background；
  // 这时前台命令到了超时直接被杀，不会转成后台作业（dsh 的 promoteOnTimeout 只在能起后台作业时生效）。
  const disabled = [...new Set([...ALWAYS_DISABLED, ...p.denyTools.flatMap(g => GROUP_ROWS[g]), ...(p.background ? [] : ['tool-jobs', 'tool-workflow'])])]
  return [
    ...disabled.map(id => ({ id, disabled: true })),
    ...(p.background || p.denyTools.includes('bash') ? [] : [{ id: 'tool-bash', config: { enableRunInBackground: false, promoteOnTimeout: false } }]),
    { id: 'skill-filesystem', config: { includeDefaultRoots: false, customSkillDirs: [skillsDir] } },
    ...(p.mcp.length === 0 ? [] : [{
      insert: p.mcp.map((m, i) => ({
        id: `eos-mcp-${i}`,
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          transport: 'stdio', serverName: m.name, command: m.command, args: m.args, env: m.env,
          // MCP 服务的子进程跑在平台自己的目录里，不是任务的 worktree：它不受 agent 沙箱约束，
          // 用的是平台进程的权限（能读写 worktree 以外的文件、能联网）。模板里加 MCP 服务等于给平台级信任。
          cwd: mcpCwd,
          toolCallTimeoutMs: 60_000, closeTimeoutMs: 5_000,
          // 配置里的值原样用，不做 ${...} 展开：模板里的值不能变成读环境变量的手段。
          expandTemplates: false,
          // 服务起不来就让会话失败，而不是让 agent 少一个工具照常干活。
          failOnStartupError: true,
        },
      })),
    }]),
  ]
}

export type LogEvent = { type: string; time: number; data?: Record<string, any> }

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 一个 zstd 帧在 buf 里从 at 开始有多长；帧不完整（文件写到一半）或不是 zstd 帧时返回 undefined。
 * 按帧头和块头算长度（RFC 8878），不靠搜索魔数：压缩数据里也可能碰巧出现魔数。
 */
const frameLength = (buf: Buffer, at: number): number | undefined => {
  if (at + 5 > buf.length) return undefined
  const magic = buf.readUInt32LE(at)
  // 可跳过帧：魔数 0x184D2A50–0x184D2A5F，后面 4 字节是内容长度。
  if ((magic & 0xfffffff0) === 0x184d2a50) return at + 8 <= buf.length && at + 8 + buf.readUInt32LE(at + 4) <= buf.length ? 8 + buf.readUInt32LE(at + 4) : undefined
  if (magic !== ZSTD_MAGIC) return undefined
  const fhd = buf[at + 4]!
  const single = (fhd >> 5) & 1
  const fcsFlag = fhd >> 6
  let pos = at + 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3]! + (fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag]!)
  for (;;) {
    if (pos + 3 > buf.length) return undefined
    const h = buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16)
    const type = (h >> 1) & 3
    if (type === 3) return undefined
    pos += 3 + (type === 1 ? 1 : h >>> 3)
    if (pos > buf.length) return undefined
    if (h & 1) break
  }
  pos += (fhd >> 2) & 1 ? 4 : 0
  return pos <= buf.length ? pos - at : undefined
}

/**
 * 解析 dsh 的会话日志（session.v4.jsonl.zstd）。dsh 每次追加写一个新的 zstd 帧；Node 的 zstdDecompressSync
 * 只解第一帧，所以逐帧解压再拼起来。
 * - 某一帧不完整或解不出（进程写到一半被杀，之后 dsh 可能接着在后面追加）：跳过它，往后找下一个帧头重新对齐；
 * - 某一行不是完整的 JSON（被跳过的帧把一行截成了两半）：跳过这一行。
 * 一帧都解不出时返回 undefined。丢掉的部分如果含有回复，调用方会按"没有回复"处理，重发这一轮。
 */
export const parseSessionLog = (buf: Buffer): LogEvent[] | undefined => {
  const parts: Buffer[] = []
  const magic = Buffer.alloc(4)
  magic.writeUInt32LE(ZSTD_MAGIC)
  for (let at = 0; at >= 0 && at < buf.length;) {
    const n = frameLength(buf, at)
    let ok = n !== undefined
    if (n !== undefined && buf.readUInt32LE(at) === ZSTD_MAGIC) {
      try {
        parts.push(zstdDecompressSync(buf.subarray(at, at + n)))
      } catch {
        ok = false
      }
    }
    at = ok ? at + n! : buf.indexOf(magic, at + 1)
  }
  if (parts.length === 0) return undefined
  return Buffer.concat(parts).toString('utf8').split('\n').flatMap(l => {
    if (l.trim() === '') return []
    try {
      const e = JSON.parse(l) as unknown
      return typeof e === 'object' && e !== null && typeof (e as LogEvent).type === 'string' ? [e as LogEvent] : []
    } catch {
      return []
    }
  })
}

const marker = (nonce: string) => `<!-- eos:${nonce} -->`

/**
 * 交给 dsh 进程的环境变量：只有白名单里的，加上模型 key。平台进程环境里别的变量（其他服务的令牌、
 * 宿主机注入的 GIT_CONFIG_*、部署方加的各种配置）都不交给 dsh，也就到不了 agent 的工具子进程。
 * 代理和证书变量要留着：服务器经代理访问模型时，没有它们 dsh 连不上模型。LC_*（只是区域设置）也留着。
 * dsh 自己的配置按名字放行，不按 DSH_ 前缀：DSH_AGENTS_HOME、DSH_SNAPSHOT* 之类残留在部署环境里会改掉 dsh 读的目录，
 * DSH_SPEECH_TOKEN 是令牌。DSH_HOME 由 SDK 按平台的 dshHome 覆盖，不用放行。
 */
export const AGENT_ENV_KEEP: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LANGUAGE', 'TMPDIR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'DSH_TELEMETRY_DISABLED', // 部署方关掉 dsh 的遥测
  // 缓存的位置和开关，部署镜像设定（见 Dockerfile、ADR-006）。agent 在沙箱里能写 /tmp、写不了家目录：
  'NARB_NATIVE_CACHE_DIR', // dsh 的 native 模块缓存放到 agent 写不了的目录，不然在 /tmp 里能被 agent 换掉
  'NODE_DISABLE_COMPILE_CACHE', // 关掉 dsh 打开的 Node 字节码缓存：默认在 /tmp，没有完整性校验
  'npm_config_cache', // npm 缓存放到 agent 能写的位置，不然 agent 的 npm install 去写不可写的家目录而失败（只放行这一项，不放行别的 npm_config_*，其中可能有 registry 认证）
  'PIP_CACHE_DIR', // 同上，pip
  'COREPACK_HOME', // 同上，corepack 下载的 pnpm、yarn
]

export const agentEnvAllowed = (name: string): boolean => AGENT_ENV_KEEP.includes(name) || name.startsWith('LC_')

export const agentEnv = (env: NodeJS.ProcessEnv, modelKey: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && agentEnvAllowed(k))),
  DEEPSEEK_API_KEY: modelKey,
})

export const sessionIdFor = (key: string): string => `session-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`

const usageOf = (events: LogEvent[]): Usage =>
  events.filter(e => e.type === 'assistant/message').reduce((u, e) => {
    const x = e.data?.usage ?? e.data?.message?.usage
    if (x === undefined) return u
    return { input: u.input + (x.inputTokens ?? 0), output: u.output + (x.outputTokens ?? 0), cacheRead: u.cacheRead + (x.cacheReadTokens ?? 0), cacheWrite: u.cacheWrite + (x.cacheWriteTokens ?? 0) }
  }, zeroUsage())

const textOf = (e: LogEvent): string => {
  const content = (e.data?.message?.content ?? e.data?.content ?? []) as { type: string; text?: string }[]
  return content.filter(c => c.type === 'text').map(c => c.text ?? '').join('')
}

const contentOf = (e: LogEvent) => (e.data?.message?.content ?? e.data?.content ?? []) as { type: string; text?: string; id?: string; name?: string; arguments?: string }[]

/** dsh 事件 → 平台的 TraceEvent。实时推送的事件和磁盘日志里的事件结构相同，都走这里；不关心的类型返回 undefined。 */
export const normalize = (e: LogEvent): TraceEvent | undefined => {
  const step = Number(e.data?.step ?? 0)
  switch (e.type) {
    case 'step/start':
      return { kind: 'step_start', t: e.time, step }
    case 'step/end':
      return { kind: 'step_end', t: e.time, step }
    case 'assistant/message': {
      const c = contentOf(e)
      const model = e.data?.message?.source?.model
      return {
        kind: 'model', t: e.time, step, usage: usageOf([e]), ...(model === undefined ? {} : { model }),
        reasoning: c.filter(x => x.type === 'reasoning').map(x => x.text ?? '').join(''),
        text: c.filter(x => x.type === 'text').map(x => x.text ?? '').join(''),
        toolCalls: c.filter(x => x.type === 'tool-call').map(x => ({ id: String(x.id), name: String(x.name), args: String(x.arguments ?? '') })),
      }
    }
    case 'tool/call':
      return { kind: 'tool_start', t: e.time, step, id: String(e.data?.callId), name: String(e.data?.name), args: String(e.data?.arguments ?? '') }
    case 'tool/result':
      return { kind: 'tool_end', t: e.time, id: String(e.data?.message?.toolCallId), output: contentOf(e).map(x => x.text ?? '').join(''), isError: e.data?.message?.isError === true }
    default:
      return undefined
  }
}

const modelOf = (events: LogEvent[]): string | undefined =>
  events.filter(e => e.type === 'assistant/message').map(e => e.data?.message?.source?.model).filter(Boolean).at(-1)

const MARKED = /<!-- eos:[^ ]+ -->/

/**
 * 带 nonce 的那条用户消息之后的回复。一次调用可能跨多个 turn（agent 等后台命令时，命令结束会再起一个 turn），
 * 所以一直看到下一条带 nonce 的消息（或日志末尾）为止，并要求最后一个 turn 已经结束；否则说明那次调用没做完。
 */
/** 带 nonce 的那条消息到下一条带 nonce 的消息之间的事件（不含两端）。 */
const rangeOf = (events: LogEvent[], nonce: string): { start: number; range: LogEvent[] } | undefined => {
  const start = events.findLastIndex(e => e.type === 'user/message' && textOf(e).includes(marker(nonce)))
  if (start < 0) return undefined
  const rest = events.slice(start + 1)
  const next = rest.findIndex(e => e.type === 'user/message' && MARKED.test(textOf(e)))
  return { start, range: next < 0 ? rest : rest.slice(0, next) }
}

/** 一次调用在会话日志里的 trace（给运行时没有记录事件流的调用回放用）。 */
export const traceAfter = (events: LogEvent[], nonce: string): TraceEvent[] => {
  const found = rangeOf(events, nonce)
  if (found === undefined) return []
  // dsh 先开始一轮和第一步，再把这条消息插进去：从这一轮的 turn/start 起算，补上排在消息前面的第一个 step/start。
  const turn = events.slice(0, found.start).findLastIndex(e => e.type === 'turn/start' || e.type === 'turn/end')
  const head = turn >= 0 && events[turn]!.type === 'turn/start' ? events.slice(turn, found.start) : []
  const t = head[0]?.time ?? events[found.start]!.time
  const lead = head.filter(e => e.type === 'step/start')
  return [{ kind: 'call_start', t }, ...[...lead, ...found.range].map(normalize).filter((x): x is TraceEvent => x !== undefined)]
}

/**
 * 一轮结束的原因里，只有 completed 算这次调用完成。
 * max-tokens 不算：dsh 在某一步达到输出上限时直接结束这一轮，那一步要调用的工具不会执行（例如写文件），
 * 回复是截断的。dsh 的 sdk profile 会把它报告为成功（maxTokensAsSuccess），但交给下游的不能是半成品。
 */
const DONE = new Set(['completed'])

const REASON: Record<string, string> = {
  interrupted: '被打断', error: '出错', aborted: '被中止', blocked: '被拦下', 'max-tokens': '输出达到上限被截断，这一步的工具调用没有执行',
}

export const describeEnd = (kind: string | null | undefined): string => REASON[kind ?? ''] ?? `结束原因为 ${kind ?? '未知'}`

export type TurnOutcome = { ok: true } | { ok: false; error: string }

/** 实时调用（send）和从日志认领（replyAfter）共用的判断。 */
export const turnOutcome = (kind: string | null | undefined, finalText = ''): TurnOutcome =>
  DONE.has(kind ?? '') ? { ok: true } : { ok: false, error: `这一轮没有正常完成（${describeEnd(kind)}）${finalText ? `：${finalText.slice(0, 200)}` : ''}` }

/**
 * 认领一次已完成的调用：最后一轮必须正常完成（见 turnOutcome）。
 * 被打断或出错的那一轮里可能有一句中间文本（例如"我先看一下目录"），不能把它当成这次调用的回复。
 */
export const replyAfter = (events: LogEvent[], nonce: string, sessionId: string): Reply | undefined => {
  const found = rangeOf(events, nonce)
  if (found === undefined) return undefined
  const { start, range } = found
  const end = range.findLastIndex(e => e.type === 'turn/end')
  if (end < 0 || range.slice(end + 1).some(e => e.type === 'turn/start')) return undefined
  if (!turnOutcome(range[end]!.data?.reason?.kind).ok) return undefined
  const turn = range.slice(0, end + 1)
  const final = turn.filter(e => e.type === 'assistant/message').map(textOf).filter(t => t.trim() !== '').at(-1)
  if (final === undefined) return undefined
  const model = modelOf(turn)
  return { sessionId, text: final, usage: usageOf(turn), ms: turn.at(-1)!.time - events[start]!.time, ...(model === undefined ? {} : { model }) }
}

export type RunLike = { finishReason: string | null; finalResponse: string; events: LogEvent[] }

/**
 * 一次实时调用的结果 → Reply；没有正常完成就抛出带原因的错误。
 * 结束原因以事件里最后一个 turn/end 为准：sdk profile 可能把 max-tokens 报告成成功，SDK 给的 finishReason 不可靠。
 */
export const replyFromRun = (r: RunLike, sessionId: string, ms: number): Reply => {
  const lastEnd = r.events.findLast(e => e.type === 'turn/end')?.data?.reason?.kind as string | undefined
  const outcome = turnOutcome(lastEnd ?? r.finishReason, r.finalResponse)
  if (!outcome.ok) throw new Error(outcome.error)
  const model = modelOf(r.events)
  return { sessionId, text: r.finalResponse, usage: usageOf(r.events), ms, ...(model === undefined ? {} : { model }) }
}

export class DshExecutor implements Executor {
  /** 按「工作目录 + 模型路由」区分的 dsh 进程。 */
  private readonly harnesses = new Map<string, { cwd: string; h: Harness; keyId: string }>()
  /** 本进程里已经打开（新建或续接）的会话，以及它在哪个工作目录的进程里。 */
  private readonly open = new Map<string, { cwd: string; s: HarnessSession }>()
  private readonly asks = new Map<string, AskHandler>()
  /** 正在关闭的进程，按工作目录：同一个 worktree 的新进程要等旧进程退出（否则会话锁还被它占着）。 */
  private readonly closing = new Map<string, Promise<unknown>>()
  /** 每个工作目录正在跑的调用数：换 key 时只关掉没有调用在跑的旧进程，不打断进行中的调用。 */
  private readonly running = new Map<string, number>()
  /** key 的指纹用 HMAC 加本进程的随机盐：不在内存里留一个能拿来比对猜测的、稳定的 key 哈希。 */
  private readonly keySalt = randomBytes(32)

  constructor(private readonly opts: {
    dshHome: string
    dshBin: string
    /** 模型 API key：每次调用前取一次；和这个工作目录的 dsh 进程启动时用的不一样（在 Web 上换了或删了），就关掉旧进程用新 key 重起。只交给 dsh 进程，dsh 不会把它传给 agent 的工具子进程。 */
    modelKey: () => string
    /** 从中按白名单挑出交给 dsh 的变量；默认是平台进程的环境。 */
    env?: NodeJS.ProcessEnv
    /** 测试用：替换真正启动 dsh 进程的构造。 */
    createHarness?: (options: DeepSeekHarnessOptions) => Harness
  }) {}

  private harness(spec: AgentSpec, modelKey: string, keyId: string): Harness {
    const route = `${spec.cwd}|${spec.model}|${spec.effort ?? ''}|${profileHash(spec.profile)}`
    let h = this.harnesses.get(route)?.h
    if (h === undefined) {
      const patch = this.materialize(spec.profile)
      const create = this.opts.createHarness ?? (o => {
        mkdirSync(o.processCwd!, { recursive: true })
        return new DeepSeekHarness(o)
      })
      h = create({
        // cwd：会话的工作区（workspace-write 的可写范围）；processCwd：dsh 进程自己的工作目录，平台的空目录。
        cwd: spec.cwd, processCwd: this.processCwd, patches: [patch],
        profile: 'sdk', dshHome: this.opts.dshHome, dshBin: this.opts.dshBin, provider: PROVIDER, model: spec.model,
        ...(spec.effort === undefined ? {} : { reasoningEffort: spec.effort as never }),
        env: agentEnv(this.opts.env ?? process.env, modelKey),
        initializeTimeoutMs: 60_000,
        onUserQuestion: async (req, { signal }) => this.answer(req.sessionId, req.questions, signal),
      })
      this.harnesses.set(route, { cwd: spec.cwd, h, keyId })
    }
    return h
  }

  /** dsh 进程的工作目录：在 dsh home 里，agent 写不到，里面没有 .env。 */
  get processCwd(): string {
    return join(this.opts.dshHome, 'process-cwd')
  }

  /** MCP 服务子进程的工作目录：平台自己的目录，不是任务的 worktree（见 patchRows 里的说明）。 */
  get mcpCwd(): string {
    return join(this.opts.dshHome, 'mcp-cwd')
  }

  /** 一个能力面在磁盘上的目录，按指纹命名：内容由指纹决定，所以重复写出来的东西完全一样。 */
  profileDir(profile: AgentProfile): string {
    return join(this.opts.dshHome, 'profiles', profileHash(profile))
  }

  /** 写出这个能力面的 profile 补丁和技能目录，返回补丁文件路径。 */
  private materialize(profile: AgentProfile): string {
    const dir = this.profileDir(profile)
    const skillsDir = join(dir, 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(this.mcpCwd, { recursive: true })
    for (const s of profile.skills) {
      // 技能名在边界上已经校验过（只有小写字母、数字和连字符），可以直接当目录名。
      mkdirSync(join(skillsDir, s.name), { recursive: true })
      writeFileSync(join(skillsDir, s.name, 'SKILL.md'), s.content)
    }
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, stringifyYaml(patchRows(profile, skillsDir, this.mcpCwd)))
    return file
  }

  /**
   * 这个会话实际拿到的工具名（从会话日志里最后一个请求头读）。
   * 核对工具组限制用：以发给模型的工具表为准，不看 agent 自己说它有什么。
   */
  toolsOffered(key: string): string[] {
    const header = this.readLog(sessionIdFor(key))?.findLast(e => e.type === 'request/header')?.data?.header as { tools?: { name?: unknown }[] } | undefined
    return (header?.tools ?? []).map(t => String(t.name)).sort()
  }

  /**
   * 这个会话实际看到的技能名（dsh 把技能目录作为一段 available_skills 注入会话）。
   * 核对技能隔离用：模板给了哪些就只有哪些，没有仓库、用户目录和 dsh 自带的技能。
   */
  skillsOffered(key: string): string[] {
    const texts = (this.readLog(sessionIdFor(key)) ?? []).filter(e => e.type === 'user/message').map(textOf)
    const block = texts.map(t => /<available_skills>([\s\S]*?)<\/available_skills>/.exec(t)?.[1]).findLast(b => b !== undefined)
    return [...(block ?? '').matchAll(/^\s*-\s*`([^`]+)`/gm)].map(m => m[1]!).sort()
  }

  /** 会话日志第一行是会话头，里面的 cwd 就是这个会话的工作区（写入边界）。 */
  private workspaceOf(id: string): string | undefined {
    const head = this.readLog(id)?.[0] as { type?: string; cwd?: unknown } | undefined
    return head?.type === 'session' && typeof head.cwd === 'string' ? head.cwd : undefined
  }

  private async answer(sessionId: string, questions: { id: string; question: string; options?: { label: string }[] }[], signal: AbortSignal) {
    const ask = this.asks.get(sessionId)
    if (ask === undefined) return { cancelled: true as const }
    const answers = []
    for (const q of questions) {
      const options = q.options?.map(o => o.label)
      const text = await ask({ id: q.id, text: q.question, ...(options === undefined ? {} : { options }) } satisfies AgentQuestion, signal)
      const picked = options?.find(o => o === text.trim())
      answers.push(picked === undefined ? { id: q.id, selected: [], custom: text } : { id: q.id, selected: [picked] })
    }
    return { answers }
  }

  private logFile(sessionId: string): string | undefined {
    const root = join(this.opts.dshHome, 'sessions')
    if (!existsSync(root)) return undefined
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, sessionId, 'session.v4.jsonl.zstd')
      if (existsSync(file)) return file
    }
    return undefined
  }

  private readLog(sessionId: string): LogEvent[] | undefined {
    const file = this.logFile(sessionId)
    if (file === undefined) return undefined
    try {
      return parseSessionLog(readFileSync(file))
    } catch {
      // 读不了（例如文件大到超出字符串上限）：按"没有回复"处理，重发这一轮。
      return undefined
    }
  }

  private async session(key: string, spec: AgentSpec): Promise<HarnessSession> {
    const id = sessionIdFor(key)
    let modelKey: string
    try {
      modelKey = this.opts.modelKey()
    } catch (e) {
      // key 被删了（或读不出来）：没有调用在跑的进程都关掉，不让它们继续拿着旧 key，再报错。
      await this.releaseIdle(() => true, spec.cwd)
      throw e
    }
    const keyId = createHmac('sha256', this.keySalt).update(modelKey).digest('hex')
    // 换了 key：没有调用在跑的旧 key 进程都关掉（包括别的工作目录的），之后的调用用新 key 重起，会话从日志续接。
    // 有调用在跑的进程（例如 agent 在等用户回答）等它的调用结束后，下一次调用时再换。
    if ([...this.harnesses.values()].some(v => v.keyId !== keyId)) await this.releaseIdle(v => v.keyId !== keyId, spec.cwd)
    const known = this.open.get(id)
    if (known !== undefined) return known.s
    await this.closing.get(spec.cwd)
    const h = this.harness(spec, modelKey, keyId)
    let s: HarnessSession
    if (this.logFile(id) !== undefined) {
      const workspace = this.workspaceOf(id)
      if (workspace === undefined || resolve(workspace) !== resolve(spec.cwd)) {
        throw new Error(`这个 agent 会话的可写范围是 ${workspace ?? '（读不到）'}，不是任务的 worktree ${spec.cwd}（会话创建于写入范围修复之前）。为了安全不再续接：请中止这个任务后重新发起。`)
      }
      s = await h.resumeSession(id)
    } else {
      s = h.session(id)
      await s.setWorkingDirectory(spec.cwd)
    }
    // 新建和续接都要设：会话在设工作目录时就已落盘（默认可写），进程若死在切换档位之前，
    // 续接回来的只读角色会带着写权限。重复选择当前档位在 dsh 里不产生变化。
    const set = await s.run(`/permission ${PRESET[spec.write]}`)
    if (set.finishReason === 'error') throw new Error(`设置权限档位失败：${set.finalResponse}`)
    // 打开会话的过程中这个 worktree 的进程被 release 了：不要把已关闭进程的会话存下来。
    if (![...this.harnesses.values()].some(v => v.h === h)) throw new Error('agent 进程在打开会话时被关闭，请重试')
    this.open.set(id, { cwd: spec.cwd, s })
    return s
  }

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    const cwd = p.spec.cwd
    this.running.set(cwd, (this.running.get(cwd) ?? 0) + 1)
    try {
      return await this.sendIn(p)
    } finally {
      const n = (this.running.get(cwd) ?? 1) - 1
      if (n === 0) this.running.delete(cwd)
      else this.running.set(cwd, n)
    }
  }

  /** 关掉满足条件、而且所在工作目录没有调用在跑的进程（调用自己的工作目录计数里不算它自己）。 */
  private async releaseIdle(match: (v: { cwd: string; keyId: string }) => boolean, self?: string): Promise<void> {
    const cwds = new Set([...this.harnesses.values()].filter(v => match(v) && (this.running.get(v.cwd) ?? 0) <= (v.cwd === self ? 1 : 0)).map(v => v.cwd))
    await Promise.all([...cwds].map(cwd => this.release(cwd)))
  }

  private async sendIn(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    const s = await this.session(p.key, p.spec)
    this.asks.set(s.id, p.ask)
    const started = Date.now()
    try {
      const r = await s.run(`${p.prompt}\n\n${marker(p.nonce)}`, {
        onNotification: n => {
          if (n.method !== 'session.event' || n.params.sessionId !== s.id || p.onEvent === undefined) return
          const e = normalize(n.params.event as LogEvent)
          if (e !== undefined) p.onEvent(e)
        },
      })
      return replyFromRun(r as unknown as RunLike, s.id, Date.now() - started)
    } finally {
      this.asks.delete(s.id)
    }
  }

  async findReply(key: string, nonce: string): Promise<Reply | undefined> {
    const id = sessionIdFor(key)
    const events = this.readLog(id)
    return events === undefined ? undefined : replyAfter(events, nonce, id)
  }

  async traceOf(key: string, nonce: string): Promise<TraceEvent[]> {
    const events = this.readLog(sessionIdFor(key))
    return events === undefined ? [] : traceAfter(events, nonce)
  }

  /** 关掉这个工作目录的 dsh 进程（任务的 runner 结束时调用）。之后再有调用会重新启动，会话从日志续接。 */
  async release(cwd: string): Promise<void> {
    const routes = [...this.harnesses].filter(([, v]) => v.cwd === cwd)
    for (const [route] of routes) this.harnesses.delete(route)
    for (const [id, v] of this.open) if (v.cwd === cwd) this.open.delete(id)
    const closed = Promise.allSettled([this.closing.get(cwd), ...routes.map(([, v]) => v.h.close())])
    this.closing.set(cwd, closed)
    await closed
    if (this.closing.get(cwd) === closed) this.closing.delete(cwd)
  }

  async close(): Promise<void> {
    await Promise.allSettled<unknown>([...[...this.harnesses.values()].map(v => v.h.close()), ...this.closing.values()])
    this.closing.clear()
    this.harnesses.clear()
    this.open.clear()
  }
}
