// Claude Code 执行器：用 Claude Agent SDK 驱动 Claude Code。唯一引用 @anthropic-ai/claude-agent-sdk 的模块（加上它的上游 claude-code-upstream.ts）。
// - 每次调用一个 query()：Claude Code 进程跑完这一轮就退出。会话 id 由 key 确定性地算出（UUID），第一次新建，之后续接。
// - 能力面按调用给（tools 白名单、插件里的技能、mcpServers），不读任何设置文件和指令文件（settingSources: []）。
// - 沙箱：整个 Claude Code 进程（和它起的所有命令）套在 Landlock 下，只能写这个会话自己的目录和 /tmp，可写的角色再加上 worktree。
//   Claude Code 自己的沙箱用的是 bwrap，在部署镜像里用不了（ADR-006），也套不进 Landlock 里。Landlock 用不了时拒绝调用。
// - 模型 key 不进 Claude Code 进程：它的 ANTHROPIC_BASE_URL 指向平台在本机起的上游（claude-code-upstream.ts），
//   拿到的只是这次调用的一次性令牌。
// - 会话日志是 <会话目录>/.claude/projects/<cwd>/<id>.jsonl：findReply、traceOf 读它。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { query, type CanUseTool, type HookCallback, type Options, type SDKMessage, type SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { MASTER_KEY_ENV } from '../credentials/key.ts'
import type { Usage } from '../engine/types.ts'
import { zeroUsage } from '../engine/types.ts'
import { asUser, withoutCaps, type CheckUser } from '../runner/check-user.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ToolGroup } from '../workflow/types.ts'
import { anthropicBaseUrl, Upstream } from './claude-code-upstream.ts'
import { confined, landlockProbe, type LandlockEnforcement } from './landlock.ts'
import type { AgentMcp, AgentProfile, AgentSpec, AskHandler, Capabilities, Executor, ExecutorContext, ExecutorKind, Health, HealthItem, ModelKeySpec, Reply } from './types.ts'
import { isHttpMcp } from './types.ts'

export const NAME = 'claude-code'

/** 角色没写 model 时用的模型。 */
export const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Claude Code 要的模型 key：凭据存储里叫 anthropic，或者平台启动时的 ANTHROPIC_API_KEY。只交给平台的上游，不交给 Claude Code 进程。 */
export const MODEL_KEY: ModelKeySpec = { credential: 'anthropic', env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key' }

/**
 * 工具组到 Claude Code 工具名（PoC 的默认工具表，poc/claude-code/README.md）。TaskStop 停后台命令和子 agent，两组都放。
 * 这个版本没有 TodoWrite，也没有对应 goal 的工具：这两组是 absent。
 */
export const GROUP_TOOLS: Record<ToolGroup, string[]> = {
  web: ['WebFetch', 'WebSearch'],
  subagent: ['Agent', 'Workflow', 'TaskStop'],
  bash: ['Bash', 'Monitor', 'TaskStop'],
  schedule: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'],
  todo: [],
  goal: [],
}

/**
 * 角色能拿到的全部自带工具（白名单，不用黑名单：新版本的 Claude Code 会加工具）。不在这里的一律不给，例如
 * ListAgents、SendMessage（和本机别的 Claude 会话通信）、EnterWorktree、ExitWorktree（换工作目录）、EnterPlanMode、ToolSearch。
 */
export const BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'Skill', 'AskUserQuestion', ...new Set(Object.values(GROUP_TOOLS).flat())]

/** 只读的角色不给的工具：写文件的。Bash 照给，Landlock 让它写不了 worktree。 */
const WRITE_TOOLS = ['Write', 'Edit', 'NotebookEdit']

export const CAPABILITIES: Capabilities = {
  toolGroups: { web: 'removable', subagent: 'removable', bash: 'removable', schedule: 'removable', todo: 'absent', goal: 'absent' },
  noBuiltinTools: true,
  noBackground: true,
  httpMcp: true,
  stdioMcp: true,
  skills: true,
}

/** 插件名：平台给角色的技能放在这个插件里，技能名是 eos:<名字>。 */
const PLUGIN = 'eos'

/** 这个能力面给 Claude Code 的自带工具。 */
export const toolsFor = (p: AgentProfile, write: AgentSpec['write']): string[] => {
  if (p.builtinTools === 'none') return []
  const denied = new Set(p.denyTools.flatMap(g => GROUP_TOOLS[g]))
  if (write === 'none') for (const t of WRITE_TOOLS) denied.add(t)
  // 不能起后台作业时连看后台输出的 Monitor 也不给；Bash、Agent 的 run_in_background 由 hook 拒绝（backgroundHook）。
  if (!p.background) denied.add('Monitor')
  if (p.skills.length === 0) denied.add('Skill')
  return BUILTIN_TOOLS.filter(t => !denied.has(t))
}

/** 会话 id：由 key 算出的 UUID（SDK 要求 UUID 格式），崩溃后总能找回同一个会话。 */
export const sessionIdFor = (key: string): string => {
  const h = createHash('sha256').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const marker = (nonce: string) => `<!-- eos:${nonce} -->`
const MARKED = /<!-- eos:[^ ]+ -->/

/**
 * Claude Code 进程的环境：只有这些（SDK 的 env 会整个替换掉进程环境）。平台进程环境里别的变量都不交给它，
 * 也就到不了 agent 的命令。代理和证书变量留着：agent 的命令（npm install 之类）要经代理上网；
 * 发往本机上游的请求不走代理（NO_PROXY 里加上本机）。
 */
export const ENV_KEEP: readonly string[] = [
  'PATH',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'npm_config_cache',
  'PIP_CACHE_DIR',
  'COREPACK_HOME',
]

/** 会话目录里 Claude Code 自己的配置目录（会话日志在它下面）和临时目录。 */
const configDir = (home: string) => join(home, '.claude')
const tmpDir = (home: string) => join(home, 'tmp')

export const processEnv = (env: NodeJS.ProcessEnv, o: { home: string; baseUrl: string; token: string; user?: string }): Record<string, string> => {
  const noProxy = [env.NO_PROXY ?? env.no_proxy ?? '', '127.0.0.1', 'localhost'].filter(s => s !== '').join(',')
  return {
    ...Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && (ENV_KEEP.includes(e[0]) || e[0].startsWith('LC_')))),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    HOME: o.home,
    ...(o.user === undefined ? {} : { USER: o.user, LOGNAME: o.user }),
    TMPDIR: tmpDir(o.home),
    CLAUDE_CONFIG_DIR: configDir(o.home),
    ANTHROPIC_BASE_URL: o.baseUrl,
    ANTHROPIC_API_KEY: o.token,
    // 不发遥测、错误报告，不自动更新，不发非必要的请求（只和模型接口通信）
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_AUTOUPDATER: '1',
    // worktree 属于平台的用户，agent 以别的用户在里面跑 git 时 git 默认拒绝（dubious ownership）。
    ...(o.user === undefined ? {} : { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' }),
  }
}

// ---- 会话日志（jsonl）→ 回复和 trace ----

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
/** 会话日志的一行，也是 SDK 发来的 user / assistant 消息（形状相同）。 */
export type Entry = {
  type: string
  timestamp?: string
  cwd?: string
  isSidechain?: boolean
  parent_tool_use_id?: string | null
  message?: { id?: string; role?: string; model?: string; content?: string | Block[]; stop_reason?: string | null; usage?: Record<string, number | undefined> }
}

const blocks = (e: Entry): Block[] => {
  const c = e.message?.content
  return typeof c === 'string' ? [{ type: 'text', text: c }] : (c ?? [])
}
const textOf = (e: Entry): string =>
  blocks(e)
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('')
const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x as { text?: string }).text ?? '').join('') : '')
const isPrompt = (e: Entry) => e.type === 'user' && MARKED.test(textOf(e))
const mainLine = (e: Entry) => e.isSidechain !== true && (e.parent_tool_use_id ?? null) === null

/** 用量：一条 API 消息在日志里按内容块拆成几行，共用同一个 message.id 和同一份 usage，按 id 去重。 */
export const usageOf = (entries: Entry[]): Usage => {
  const byId = new Map<string, Record<string, number | undefined>>()
  for (const e of entries) if (e.type === 'assistant' && e.message?.usage !== undefined) byId.set(e.message.id ?? String(byId.size), e.message.usage)
  const u = zeroUsage()
  for (const x of byId.values()) {
    u.input += x.input_tokens ?? 0
    u.output += x.output_tokens ?? 0
    u.cacheRead += x.cache_read_input_tokens ?? 0
    u.cacheWrite += x.cache_creation_input_tokens ?? 0
  }
  return u
}

export const parseLog = (raw: string): Entry[] =>
  raw.split('\n').flatMap(l => {
    if (l.trim() === '') return []
    try {
      const e = JSON.parse(l) as Entry
      return typeof e === 'object' && e !== null && typeof e.type === 'string' ? [e] : []
    } catch {
      // 崩溃时写了一半的最后一行
      return []
    }
  })

/** 带 nonce 的那条用户消息到下一条带 nonce 的消息之间（不含两端），只看主会话（不含子 agent）。 */
const rangeOf = (entries: Entry[], nonce: string): { start: Entry; range: Entry[] } | undefined => {
  const main = entries.filter(mainLine)
  const at = main.findLastIndex(e => e.type === 'user' && textOf(e).includes(marker(nonce)))
  if (at < 0) return undefined
  const rest = main.slice(at + 1)
  const next = rest.findIndex(isPrompt)
  return { start: main[at]!, range: next < 0 ? rest : rest.slice(0, next) }
}

const time = (e: Entry | undefined, fallback = 0): number => {
  const t = e?.timestamp === undefined ? NaN : Date.parse(e.timestamp)
  return Number.isNaN(t) ? fallback : t
}

/** 认领一次已完成的调用：最后一条 assistant 消息正常结束（end_turn），而且有文字。 */
export const replyAfter = (entries: Entry[], nonce: string, sessionId: string): Reply | undefined => {
  const found = rangeOf(entries, nonce)
  if (found === undefined) return undefined
  const assistant = found.range.filter(e => e.type === 'assistant')
  const last = assistant.at(-1)
  if (last?.message?.stop_reason !== 'end_turn') return undefined
  // 结束的那条消息按内容块拆成几行：取同一个 message.id 的文字
  const text = assistant
    .filter(e => e.message?.id === last.message?.id)
    .map(textOf)
    .join('')
  if (text.trim() === '') return undefined
  const model = last.message.model
  return { sessionId, text, usage: usageOf(found.range), ms: time(last) - time(found.start), ...(model === undefined ? {} : { model }) }
}

/**
 * 把 SDK 的消息（或会话日志的行）逐条转成 TraceEvent。同一个 message.id 的几条是一次模型请求（一步）：
 * 攒齐了再发 model 事件，接着是它要调用的工具；工具结果是 tool_end。
 */
export class TraceStream {
  private step = 0
  private pending: Entry[] = []
  private open = false

  constructor(private readonly emit: (e: TraceEvent) => void) {}

  private flush(t: number): void {
    if (this.pending.length === 0) return
    const bs = this.pending.flatMap(blocks)
    const first = this.pending[0]!
    const calls = bs.filter(b => b.type === 'tool_use').map(b => ({ id: String(b.id), name: String(b.name), args: JSON.stringify(b.input ?? {}) }))
    this.pending = []
    this.emit({
      kind: 'model',
      t,
      step: this.step,
      usage: usageOf([first]),
      ...(first.message?.model === undefined ? {} : { model: first.message.model }),
      reasoning: bs
        .filter(b => b.type === 'thinking')
        .map(b => b.thinking ?? '')
        .join(''),
      text: bs
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join(''),
      toolCalls: calls,
    })
    for (const c of calls) this.emit({ kind: 'tool_start', t, step: this.step, ...c })
  }

  push(e: Entry, t: number): void {
    if (!mainLine(e)) return
    if (e.type === 'assistant') {
      if (this.pending.length > 0 && this.pending[0]!.message?.id !== e.message?.id) this.flush(t)
      if (this.pending.length === 0) {
        if (this.open) this.emit({ kind: 'step_end', t, step: this.step })
        this.step++
        this.open = true
        this.emit({ kind: 'step_start', t, step: this.step })
      }
      this.pending.push(e)
      return
    }
    if (e.type === 'user') {
      this.flush(t)
      for (const b of blocks(e).filter(b => b.type === 'tool_result')) this.emit({ kind: 'tool_end', t, id: String(b.tool_use_id), output: resultText(b.content), isError: b.is_error === true })
    }
  }

  end(t: number): void {
    this.flush(t)
    if (this.open) this.emit({ kind: 'step_end', t, step: this.step })
    this.open = false
  }
}

export const traceAfter = (entries: Entry[], nonce: string): TraceEvent[] => {
  const found = rangeOf(entries, nonce)
  if (found === undefined) return []
  const out: TraceEvent[] = [{ kind: 'call_start', t: time(found.start) }]
  const s = new TraceStream(e => out.push(e))
  let t = time(found.start)
  for (const e of found.range) s.push(e, (t = time(e, t)))
  s.end(t)
  return out
}

/** 实时调用的结果 → Reply；没有正常完成就抛出带原因的错误。 */
export const replyFromResult = (r: SDKMessage | undefined, sessionId: string, model: string): Reply => {
  if (r === undefined || r.type !== 'result') throw new Error('Claude Code 没有给出这一轮的结果就退出了')
  if (r.subtype !== 'success' || r.is_error) {
    const why = r.subtype === 'success' ? r.result : (r.errors ?? []).join('；')
    throw new Error(`这一轮没有正常完成（${r.subtype}${r.stop_reason ? `，${r.stop_reason}` : ''}）${why ? `：${why.slice(0, 300)}` : ''}`)
  }
  // 输出达到上限：那一步要调用的工具没有执行，回复是截断的，不能当成完成。
  if (r.stop_reason !== null && r.stop_reason !== 'end_turn') throw new Error(`这一轮没有正常完成（结束原因为 ${r.stop_reason}）：${r.result.slice(0, 200)}`)
  const u = r.usage
  return {
    sessionId,
    text: r.result,
    usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
    ms: r.duration_ms,
    model: Object.keys(r.modelUsage ?? {})[0] ?? model,
  }
}

// ---- 执行器 ----

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 在 $1 下找会话 $2 的日志并原样输出（以 agent 的用户运行：会话目录是 0700，只有它能读）。 */
const CAT_LOG = 'for f in "$1"/.claude/projects/*/"$2".jsonl; do if [ -f "$f" ]; then exec cat "$f"; fi; done; exit 3'

/** 结束命令行里带 $1 的进程（不含这个 shell 自己：它的参数里也有 $1）。以 agent 的用户运行时只碰得到它的进程。 */
const KILL_SESSION =
  'for p in /proc/[0-9]*; do n=${p#/proc/}; [ "$n" = "$$" ] && continue; case "$(tr "\\000" " " < "$p/cmdline" 2>/dev/null)" in *"$1"*) kill -KILL "$n" 2>/dev/null;; esac; done; exit 0'

export type ClaudeCodeOptions = {
  /** 执行器的数据目录（平台数据目录下的 claude-code/）。 */
  home: string
  /** 模型 key：每次转发时取，在 Web 上换了 key 之后的请求就用新的。只交给上游。 */
  modelKey: () => string
  /** 模型接口地址（anthropicBaseUrl）。 */
  target: string
  env?: NodeJS.ProcessEnv
  /** agent 的用户（部署镜像里设置）：Claude Code 进程以它运行，会话目录属于它。 */
  agentUser?: CheckUser
  /** 这台机器上 Landlock 能不能用；默认真的探测一次。 */
  landlock?: () => LandlockEnforcement
  /** 测试用：替换 SDK 的 query。 */
  query?: typeof query
}

export class ClaudeCodeExecutor implements Executor {
  private readonly upstream: Upstream
  /** 正在跑的调用：按工作目录，release 时中止。 */
  private readonly running = new Map<string, Set<AbortController>>()
  private enforcement: LandlockEnforcement | undefined

  constructor(private readonly o: ClaudeCodeOptions) {
    this.upstream = new Upstream(o.target)
  }

  get sessionsRoot(): string {
    return join(this.o.home, 'sessions')
  }

  /** 一个会话的目录：Claude Code 的 HOME、配置目录（会话日志）、临时目录都在这里。按会话分开：agent 只能写自己这个会话的。 */
  sessionHome(id: string): string {
    return join(this.sessionsRoot, id)
  }

  private sandbox(): LandlockEnforcement {
    this.enforcement ??= (this.o.landlock ?? landlockProbe)()
    return this.enforcement
  }

  /** 以 agent 的用户（设置了时）运行一个短命令。 */
  private run(argv: string[]): ReturnType<typeof spawnSync> {
    const [cmd, ...args] = this.o.agentUser === undefined ? withoutCaps(argv) : asUser(this.o.agentUser, argv)
    return spawnSync(cmd!, args, { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024, timeout: 30_000 })
  }

  /** 建会话目录。部署镜像里由 agent 的用户建（属于它，0700）；Claude Code 进程以它运行，要能写。 */
  private ensureHome(id: string): string {
    const home = this.sessionHome(id)
    if (this.o.agentUser === undefined) {
      mkdirSync(tmpDir(home), { recursive: true, mode: 0o700 })
      return home
    }
    const r = this.run(['sh', '-c', 'umask 077 && mkdir -p "$1/tmp"', 'sh', home])
    if (r.status !== 0) throw new Error(`以 ${this.o.agentUser.name} 建会话目录失败：${r.error?.message ?? r.stderr?.toString().trim()}`)
    return home
  }

  /** 读会话日志：没有时 undefined，读不出来时抛错（不能当成新会话）。 */
  readLog(id: string): Entry[] | undefined {
    const home = this.sessionHome(id)
    if (this.o.agentUser === undefined) {
      const dir = join(configDir(home), 'projects')
      if (!existsSync(dir)) return undefined
      for (const p of readdirSync(dir)) {
        const f = join(dir, p, `${id}.jsonl`)
        if (existsSync(f)) return parseLog(readFileSync(f, 'utf8'))
      }
      return undefined
    }
    const r = this.run(['sh', '-c', CAT_LOG, 'sh', home, id])
    if (r.status === 3) return undefined
    if (r.status !== 0) throw new Error(`以 ${this.o.agentUser.name} 读会话日志 ${id} 失败：${r.error?.message ?? r.stderr?.toString().trim()}`)
    return parseLog(r.stdout.toString())
  }

  /**
   * 平台给这个能力面的技能：写成数据目录里的一个本地插件（按内容的指纹命名，内容由指纹决定），agent 只读。
   * 先核对 eos-profiles 是平台自己的真目录：执行器目录组内可写（部署镜像里），agent 的用户能在里面放同名的链接。
   */
  private plugin(p: AgentProfile): string | undefined {
    if (p.builtinTools === 'none' || p.skills.length === 0) return undefined
    const top = join(this.o.home, 'eos-profiles')
    mkdirSync(this.o.home, { recursive: true })
    if (!existsSync(top) && !isLink(top)) mkdirSync(top, { mode: 0o755 })
    const st = lstatSync(top)
    if (st.isSymbolicLink() || !st.isDirectory() || (process.getuid !== undefined && st.uid !== process.getuid())) {
      throw new Error(`${top} 不是平台自己的目录（可能被换成了链接，或者被别的用户先建了）：为了安全不往里写。删掉它后重试`)
    }
    const hash = createHash('sha256').update(JSON.stringify(p.skills)).digest('hex').slice(0, 32)
    const dir = join(top, hash)
    if (relative(top, dir).split(sep).length !== 1) throw new Error('技能目录的路径不对')
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true, mode: 0o755 })
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version: '0.0.0', description: '平台给这个角色的技能' }), { mode: 0o644 })
    for (const s of p.skills) {
      // 技能名在边界上已经校验过（只有小写字母、数字和连字符），可以直接当目录名。
      mkdirSync(join(dir, 'skills', s.name), { recursive: true, mode: 0o755 })
      writeFileSync(join(dir, 'skills', s.name, 'SKILL.md'), s.content, { mode: 0o644 })
    }
    return dir
  }

  /**
   * Landlock 下能写的：会话目录、/tmp，可写的角色加上 worktree；还有 /dev/null 和 /dev/tty（有时）。
   * /tmp 和 dsh 在 Landlock 下一样能写：部署镜像把 npm、pip、corepack 的缓存放在 /tmp（Dockerfile），agent 装依赖要写它。
   * 平台和执行器自己会加载的东西都不放在 /tmp（ADR-006）。
   */
  private grants(home: string, spec: AgentSpec): string[] {
    return [home, '/tmp', ...(spec.write === 'worktree' ? [spec.cwd] : []), '/dev/null', ...(existsSync('/dev/tty') ? ['/dev/tty'] : [])]
  }

  /** 起 Claude Code 进程：清掉能力（或切换到 agent 的用户），再套上 Landlock。stderr 留最后一段，进程异常退出时放进报错。 */
  private spawner(writable: string[], stderr: { tail: string }) {
    return (s: SpawnOptions) => {
      const inner = confined(writable, [s.command, ...s.args])
      const argv = this.o.agentUser === undefined ? withoutCaps(inner) : asUser(this.o.agentUser, inner)
      const child = spawn(argv[0]!, argv.slice(1), { cwd: s.cwd, env: s.env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: s.signal })
      child.stderr.on('data', (d: Buffer) => {
        stderr.tail = (stderr.tail + d.toString()).slice(-2000)
      })
      return child
    }
  }

  /**
   * 同一个会话的进程如果还活着（平台崩溃留下的孤儿，ppid 是 1），先结束它：它会和这次调用同时写同一个会话。
   * 命令行里带会话 id（--session-id、--resume）的就是。按 /proc 找，不依赖 pkill（部署镜像里没有 procps）。
   */
  private killStale(id: string): void {
    this.run(['sh', '-c', KILL_SESSION, 'sh', id])
  }

  private mcpServers(mcp: AgentMcp[]): Options['mcpServers'] {
    return Object.fromEntries(
      mcp.map(m => [m.name, isHttpMcp(m) ? { type: 'http' as const, url: m.url, headers: m.headers } : { type: 'stdio' as const, command: m.command, args: m.args, env: m.env }]),
    )
  }

  async send(p: { key: string; spec: AgentSpec; prompt: string; nonce: string; ask: AskHandler; onEvent?: (e: TraceEvent) => void }): Promise<Reply> {
    const { spec } = p
    const enforcement = this.sandbox()
    if (enforcement === 'unusable') throw new Error('这台机器上 Landlock 用不了：Claude Code 执行器只在 Landlock 下运行 agent，拒绝这次调用（见 eos doctor 的「Claude Code 沙箱」一项）')
    // 没有 key 时不起进程：先取一次，取不到就报错（转发时还会每次重新取）
    this.o.modelKey()
    const id = sessionIdFor(p.key)
    const log = this.readLog(id)
    if (log !== undefined) {
      const cwd = log.find(e => typeof e.cwd === 'string')?.cwd
      if (cwd !== undefined && cwd !== spec.cwd) throw new Error(`这个 agent 会话的工作目录是 ${cwd}，不是任务的 worktree ${spec.cwd}：为了安全不再续接。请中止这个任务后重新发起。`)
    }
    const home = this.ensureHome(id)
    this.killStale(id)
    const ac = new AbortController()
    const set = this.running.get(spec.cwd) ?? new Set()
    set.add(ac)
    this.running.set(spec.cwd, set)
    const grant = this.upstream.grant(this.o.modelKey)
    const stderr = { tail: '' }
    try {
      const baseUrl = await this.upstream.url()
      const model = spec.model ?? DEFAULT_MODEL
      const tools = toolsFor(spec.profile, spec.write)
      const plugin = this.plugin(spec.profile)
      const mcpNames = spec.profile.mcp.map(m => m.name)
      const options: Options = {
        cwd: spec.cwd,
        env: processEnv(this.o.env ?? process.env, { home, baseUrl, token: grant.token, ...(this.o.agentUser === undefined ? {} : { user: this.o.agentUser.name }) }),
        model,
        ...(spec.effort === undefined ? {} : { effort: spec.effort }),
        thinking: { type: 'adaptive', display: 'summarized' },
        tools,
        settingSources: [],
        permissionMode: spec.write === 'worktree' ? 'acceptEdits' : 'default',
        ...(log === undefined ? { sessionId: id } : { resume: id }),
        ...(plugin === undefined ? {} : { plugins: [{ type: 'local' as const, path: plugin }], skills: spec.profile.skills.map(s => `${PLUGIN}:${s.name}`) }),
        mcpServers: this.mcpServers(spec.profile.mcp),
        hooks: { PreToolUse: [{ hooks: [gate(tools, mcpNames, spec.profile.background)] }] },
        canUseTool: answer(p.ask),
        abortController: ac,
        spawnClaudeCodeProcess: this.spawner(this.grants(home, spec), stderr),
      }
      let result: SDKMessage | undefined
      const trace = new TraceStream(e => p.onEvent?.(e))
      p.onEvent?.({ kind: 'call_start', t: Date.now() })
      try {
        for await (const m of (this.o.query ?? query)({ prompt: `${p.prompt}\n\n${marker(p.nonce)}`, options })) {
          if (m.type === 'assistant' || m.type === 'user') trace.push(m as Entry, Date.now())
          if (m.type === 'result') result = m
        }
      } catch (e) {
        if (ac.signal.aborted) throw new Error('调用被中止（agent 进程被关闭）')
        throw new Error(`Claude Code 出错：${(e as Error).message}${stderr.tail.trim() === '' ? '' : `\n${stderr.tail.trim()}`}`)
      } finally {
        trace.end(Date.now())
      }
      return replyFromResult(result, id, model)
    } finally {
      grant.revoke()
      set.delete(ac)
      if (set.size === 0) this.running.delete(spec.cwd)
    }
  }

  async findReply(key: string, nonce: string): Promise<Reply | undefined> {
    const id = sessionIdFor(key)
    const log = this.readLog(id)
    return log === undefined ? undefined : replyAfter(log, nonce, id)
  }

  async traceOf(key: string, nonce: string): Promise<TraceEvent[]> {
    const log = this.readLog(sessionIdFor(key))
    return log === undefined ? [] : traceAfter(log, nonce)
  }

  /** 中止这个工作目录里正在跑的调用（Claude Code 进程连同它起的命令一起结束）。之后的调用照常可用，会话从日志续接。 */
  async release(cwd: string): Promise<void> {
    for (const ac of this.running.get(cwd) ?? []) ac.abort()
  }

  async close(): Promise<void> {
    for (const set of this.running.values()) for (const ac of set) ac.abort()
    await this.upstream.close()
  }
}

/**
 * 每次工具调用前的检查（PreToolUse hook 每次都触发；canUseTool 不是）：不在白名单里的工具拒绝
 * （tools 白名单管不到 MCP 工具，MCP 工具按挂了的服务名放行）；不能起后台作业时拒绝带 run_in_background 的调用。
 */
export const gate =
  (tools: readonly string[], mcp: readonly string[], background: boolean): HookCallback =>
  async input => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: reason } })
    const name = input.tool_name
    const allowed = tools.includes(name) || mcp.some(s => name.startsWith(`mcp__${s}__`))
    if (!allowed) return deny(`平台没有给这个角色 ${name} 工具`)
    const arg = input.tool_input as { run_in_background?: unknown } | null
    if (!background && arg?.run_in_background === true) return deny('这个角色不能起后台作业：请在前台运行')
    return {}
  }

/** 需要许可的调用：AskUserQuestion 转给平台问用户；别的放行（工具已经由 gate 过滤，写入范围由 Landlock 限制）。 */
export const answer =
  (ask: AskHandler): CanUseTool =>
  async (name, input, { signal, toolUseID }) => {
    if (name !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input }
    const qs = ((input as { questions?: unknown }).questions ?? []) as { question: string; options?: { label: string }[] }[]
    const answers: Record<string, string> = {}
    for (const [i, q] of qs.entries()) {
      const options = q.options?.map(o => o.label)
      answers[q.question] = await ask({ id: `${toolUseID ?? 'q'}-${i}`, text: q.question, ...(options === undefined ? {} : { options }) }, signal)
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } }
  }

// ---- 自检（eos doctor 里 Claude Code 的几项）和在注册表里的登记 ----

/** 自检看的事实：claudeCodeHealth 只看它，不做 IO，可单测。 */
export type ClaudeCodeFacts = {
  /** SDK 和它带的 Claude Code 版本；没装好时 missing。 */
  install: { version: string } | { missing: true }
  landlock: LandlockEnforcement
  modelKey: { source: 'credentials' | 'env' | 'missing' } | { source: 'error'; error: string }
  credentialsUsable: boolean
  /** EOS_ANTHROPIC_BASE_URL：没设置时没有；设了时是主机，或者校验失败的原因。 */
  baseUrl?: { kind: 'ok'; host: string; official: boolean } | { kind: 'invalid'; error: string }
}

const OFFICIAL_HOST = 'api.anthropic.com'

/**
 * 不是每个部署都用 Claude Code：没准备好的地方只提示（warn），不拦下平台启动，并且只在 eos doctor 里列出。
 * 用到它的角色在调用时报错（没有 key、没有 Landlock 时拒绝调用）。
 */
export const claudeCodeHealth = (f: ClaudeCodeFacts): Health => {
  const items: HealthItem[] = []
  const note = (name: string, detail: string, fix: string): HealthItem => ({ name, status: 'warn', detail, fix, doctorOnly: true })
  items.push(
    'version' in f.install
      ? { name: 'Claude Code', status: 'ok', detail: f.install.version }
      : note('Claude Code', '没有安装，或安装不完整：用 claude-code 执行器的角色跑不起来', '在仓库目录运行 npm install'),
  )
  const key = MODEL_KEY
  switch (f.modelKey.source) {
    case 'credentials':
      items.push({ name: key.label, status: 'ok', detail: `来自凭据存储（凭据 ${key.credential}）` })
      break
    case 'env':
      items.push({ name: key.label, status: 'ok', detail: `来自环境变量 ${key.env}（凭据存储里没有 ${key.credential}）` })
      break
    case 'missing':
      items.push(
        note(
          key.label,
          `没有设置：用 claude-code 执行器的角色跑不起来${f.credentialsUsable ? '' : `（主密钥 ${MASTER_KEY_ENV} 没有设置或无效，凭据存储存不进凭据）`}`,
          `在 Web 的「凭据」页添加名为 ${key.credential}、类型为「模型 API key」的凭据；或在启动平台的环境里设置 ${key.env}=<你的 key>`,
        ),
      )
      break
    case 'error':
      items.push(note(key.label, `凭据存储里的 ${key.credential} 读不出来：${f.modelKey.error}`, `修好或删掉这条凭据后重新录入`))
  }
  items.push(
    f.landlock === 'full'
      ? { name: 'Claude Code 沙箱', status: 'ok', detail: 'Landlock：agent 只能写自己的会话目录和 /tmp，可写的 agent 还能写自己的 worktree；读不到别的进程的环境，各任务共用 /tmp' }
      : f.landlock === 'partial'
        ? note('Claude Code 沙箱', 'Landlock，但内核的 Landlock 版本较旧，只能限制一部分写操作', '换用较新的内核')
        : note('Claude Code 沙箱', 'Landlock 用不了：Claude Code 执行器拒绝调用', '使用启用了 Landlock 的 Linux 内核（5.13 以上，LSM 列表里有 landlock）'),
  )
  if (f.baseUrl !== undefined) {
    if (f.baseUrl.kind === 'invalid') items.push({ name: 'Anthropic 接口地址', status: 'fail', detail: f.baseUrl.error, fix: '改正环境变量 EOS_ANTHROPIC_BASE_URL；用官方接口时删掉它' })
    else if (!f.baseUrl.official)
      items.push(note('Anthropic 接口地址', `EOS_ANTHROPIC_BASE_URL 指向 ${f.baseUrl.host}：模型请求和 Anthropic API key 都会发到这台主机`, '确认这是你信任的网关；不需要时删掉它'))
  }
  // Landlock 用不了时执行器拒绝调用，agent 不会在沙箱外运行。
  return { items, sandboxed: true }
}

/** SDK 的版本，以及它按平台分的可选依赖里那个原生的 Claude Code 在不在（SDK 的 exports 没有导出 package.json，按入口文件找目录）。 */
export const installFact = (root: string, platform: string = process.platform, arch: string = process.arch): ClaudeCodeFacts['install'] => {
  try {
    const dir = dirname(createRequire(join(root, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk'))
    const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version
    const native = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
    const found = (createRequire(join(dir, 'package.json')).resolve.paths(native) ?? []).some(p => existsSync(join(p, native, 'package.json')))
    return version === undefined || !found ? { missing: true } : { version: `SDK ${version}` }
  } catch {
    return { missing: true }
  }
}

const baseUrlFact = (env: NodeJS.ProcessEnv): Pick<ClaudeCodeFacts, 'baseUrl'> => {
  if ((env.EOS_ANTHROPIC_BASE_URL ?? '') === '') return {}
  try {
    const host = new URL(anthropicBaseUrl(env)).host
    return { baseUrl: { kind: 'ok', host, official: host === OFFICIAL_HOST } }
  } catch (e) {
    return { baseUrl: { kind: 'invalid', error: (e as Error).message } }
  }
}

export const claudeCodeFacts = (ctx: ExecutorContext, landlock: () => LandlockEnforcement = landlockProbe): ClaudeCodeFacts => {
  const k = ctx.modelKey()
  return {
    install: installFact(ctx.root),
    landlock: landlock(),
    modelKey: k.source === 'credentials' || k.source === 'env' ? { source: k.source } : k,
    credentialsUsable: ctx.credentialsUsable,
    ...baseUrlFact(ctx.env),
  }
}

const currentKey = (ctx: ExecutorContext): string => {
  const k = ctx.modelKey()
  if (k.source === 'credentials' || k.source === 'env') return k.value
  throw new Error(k.source === 'error' ? `Anthropic API key 读不出来：${k.error}` : `没有可用的 Anthropic API key：凭据存储里没有 ${MODEL_KEY.credential}，也没有设置 ${MODEL_KEY.env}`)
}

export const claudeCode: ExecutorKind = {
  name: NAME,
  capabilities: CAPABILITIES,
  modelKey: MODEL_KEY,
  create: ctx =>
    new ClaudeCodeExecutor({
      home: join(ctx.dataDir, NAME),
      modelKey: () => currentKey(ctx),
      target: anthropicBaseUrl(ctx.env),
      env: ctx.env,
      ...(ctx.agentUser === undefined ? {} : { agentUser: ctx.agentUser }),
    }),
  health: ctx => claudeCodeHealth(claudeCodeFacts(ctx)),
}
