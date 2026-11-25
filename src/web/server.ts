// Web 服务：JSON 接口 + 前端静态文件。默认只监听本机地址；第一版没有登录。
// 写接口（新建任务、回答、继续、重试、中止）都要求 JSON 请求体和同源 Origin，挡住其他网页向本服务发的跨站请求。
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { describePosition, sessionOf } from '../engine/machine.ts'
import { insights, sampleAt } from '../engine/insights.ts'
import { taskMetrics } from '../engine/metrics.ts'
import { report } from '../engine/report.ts'
import type { CheckLink, Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import { generate } from '../improve/generate.ts'
import { Proposals } from '../improve/proposals.ts'
import { GENERATE_HINT } from '../credentials/key.ts'
import type { Credentials } from '../credentials/store.ts'
import { CREDENTIAL_KINDS, type CredentialKind, LOCAL_OWNER } from '../credentials/types.ts'
import { evidence } from '../engine/evidence.ts'
import { compare, versionUsed, type CompareSample } from '../engine/compare.ts'
import { keyOf, nonceOf } from '../runner/runner.ts'
import { committedChanges, fileDiff, onBranch } from '../runner/git.ts'
import type { Supervisor } from '../runner/supervisor.ts'
import type { Store } from '../store/store.ts'
import { buildTrace } from '../trace/build.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ConventionKind } from '../store/types.ts'
import type {
  ActionResponse, AnswerResponse, ConventionDetail, CredentialsResponse, ForgeAppsResponse, RegisterAppResponse, AuthorizeUserResponse, RevokeUserResponse, ForgeAppInfo, DeleteCredentialResponse, SaveCredentialResponse, ConventionsResponse, CreateResponse, DecideResponse, GenerateResponse, ImprovementComparison, ProposalDetail, ProposalInfo, FileDiff, SaveConventionResponse, TaskChanges, TaskDetail, WorkflowInfo,
} from './types.ts'

/** /api/conventions/<workflow|doc|template|skill>/<名字>，名字可以是中文（URL 编码）。 */
const CONVENTION = /^\/api\/conventions\/(workflow|doc|template|skill)\/([^/]+)$/

/** /api/improve/proposals/<id>，以及审批：/api/improve/proposals/<id>/(approve|reject)。 */
const PROPOSAL = /^\/api\/improve\/proposals\/(\d{1,15})$/
const DECIDE = /^\/api\/improve\/proposals\/(\d{1,15})\/(approve|reject)$/


const decodeName = (raw: string): string | undefined => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return undefined
  }
}

/** 检查产出的链接：同一个地址只保留一条，排在它最后一次出现的位置，标签用最新的。 */
export const linksOf = (t: Task): CheckLink[] => {
  const byUrl = new Map<string, CheckLink>()
  for (const e of t.log) if (e.type === 'check') for (const r of e.results) for (const l of r.links ?? []) {
    byUrl.delete(l.url)
    byUrl.set(l.url, l)
  }
  return [...byUrl.values()]
}

const summaryOf = (t: Task) => ({ id: t.id, status: t.status, workflow: t.workflow.name })

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

const MAX_BODY = 64 * 1024

/** 读 JSON 请求体。超过上限的照样读完（只是不保存），这样客户端能收到 413 而不是断开的连接。 */
const readJson = (req: IncomingMessage): Promise<{ tooBig: true } | { value: unknown }> => new Promise(resolve => {
  let size = 0
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size <= MAX_BODY) chunks.push(c)
  })
  req.on('end', () => {
    if (size > MAX_BODY) return resolve({ tooBig: true })
    try {
      resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    } catch {
      resolve({ value: undefined })
    }
  })
  req.on('error', () => resolve({ value: undefined }))
})

/**
 * 外部地址（EOS_PUBLIC_URL）：部署在容器或反向代理后面时，浏览器地址栏里的地址。只取 http(s) 的 origin，
 * 带路径、查询、用户名的都不接受（平台只挂在根路径上）。返回错误说明，由命令行报出来。
 */
export const parsePublicUrl = (raw: string): URL | string => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return `EOS_PUBLIC_URL 不是合法的地址：${raw}`
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `EOS_PUBLIC_URL 只支持 http 或 https：${raw}`
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return `EOS_PUBLIC_URL 只能是 协议://主机[:端口]，不能带路径、查询或用户名：${raw}`
  return new URL(u.origin)
}

/**
 * 这个 Host 对应的唯一合法 Origin；Host 不被接受时为 undefined。
 * 接受两类 Host：本机地址加本服务的端口，以及外部地址的主机部分。挡住 DNS 重绑定：攻击者的域名解析到本服务时，
 * Origin 和 Host 都是攻击者的域名、彼此一致，只比较两者挡不住，所以先限定 Host 本身。
 */
export const originFor = (host: string | undefined, port: number | undefined, publicUrl: URL | undefined): string | undefined => {
  if (host === undefined) return undefined
  if (['127.0.0.1', 'localhost', '[::1]'].some(h => host === `${h}:${port}`)) return `http://${host}`
  if (publicUrl === undefined) return undefined
  // 精确比较，只放宽大小写和默认端口：反向代理可能传来 EOS.example.com 或 eos.example.com:443。
  const h = host.toLowerCase()
  return h === publicUrl.host || h === `${publicUrl.host}:${publicUrl.protocol === 'https:' ? 443 : 80}` ? publicUrl.origin : undefined
}

const WILDCARD = ['0.0.0.0', '::']
const LOOPBACK: Record<string, string> = { '127.0.0.1': 'http://127.0.0.1', localhost: 'http://localhost', '::1': 'http://[::1]' }

/**
 * 按监听地址算出浏览器该打开的地址，以及要不要警告（监听了非本机地址）。
 * 不设外部地址时只能通过本机地址访问，所以监听某个具体的非本机地址（或 127.0.0.2 这类）就没人能用：直接报错。
 */
export const listenPlan = (host: string, port: number, publicUrl: URL | undefined): { url: string; exposed: boolean } | string => {
  const exposed = LOOPBACK[host] === undefined
  if (publicUrl !== undefined) return { url: publicUrl.origin, exposed }
  if (LOOPBACK[host] !== undefined) return { url: `${LOOPBACK[host]}:${port}`, exposed }
  if (WILDCARD.includes(host)) return { url: `http://localhost:${port}`, exposed }
  return `监听 ${host} 时浏览器的 Host 是 ${host}:${port}，不是本机地址；要么改用 --host 0.0.0.0，要么把浏览器用的地址设成 EOS_PUBLIC_URL`
}

/** 托管平台注册完 App 跳回的路径。 */
export const APP_CALLBACK = '/api/forge-apps/callback'
/** 用户在托管平台上授权（OAuth）完跳回的路径。注册 App 时写进 App 的回调地址。 */
export const USER_CALLBACK = '/api/forge-apps/user-callback'
/** 发起注册后多久内要完成（在托管平台的页面上确认）。 */
const PENDING_MS = 30 * 60 * 1000

/** 日志接口最多返回的字节数（从文件末尾算）。 */
export const LOG_TAIL = 2 * 1024 * 1024

export const tail = (path: string, max: number): string => {
  const size = statSync(path).size
  if (size <= max) return readFileSync(path, 'utf8')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(max)
    const n = readSync(fd, buf, 0, max, size - max)
    const text = buf.subarray(0, n).toString('utf8')
    // 从中间截断：丢掉第一个换行之前的半行；没有换行时去掉开头被截断的半个字符（解码成的替换字符）。
    const nl = text.indexOf('\n')
    const body = nl < 0 ? text.replace(/^\uFFFD+/, '') : text.slice(nl + 1)
    return `（日志共 ${size} 字节，只显示最后 ${max} 字节；完整日志：${path}）\n${body}`
  } finally {
    closeSync(fd)
  }
}

/** improve：生成改进提案要用的执行器和数据目录；不给就没有生成接口（返回 503）。 */
/**
 * publicUrl：外部地址，见 parsePublicUrl；不给时只接受本机地址。
 * credentials：凭据存储。凭据的值只写不读：接口不返回值，错误信息里也不带值。
 * 现在没有登录，所有凭据都属于 LOCAL_OWNER；接上登录后按登录的用户取 owner。
 */
export const createWebServer = (o: { store: Store; supervisor: Supervisor; replay: Pick<Executor, 'traceOf'>; staticDir: string; credentials: Credentials; improve?: { executor: Executor; dataDir: string }; publicUrl?: URL }): Server => {
  const allowedOrigin = (req: IncomingMessage) => originFor(req.headers.host, req.socket.localPort, o.publicUrl)

  /** 已完成调用的回放结果不会再变，按任务和调用缓存。 */
  const replayed = new Map<string, TraceEvent[]>()

  const traceRows = async (task: Task) => {
    const rows = o.store.trace(task.id).map(r => ({ call: r.call, event: r.event }))
    const have = new Set(rows.map(r => r.call))
    for (const e of task.log) {
      if (e.type !== 'call' || have.has(e.call)) continue
      // 引入事件流之前跑完的调用：从 dsh 会话日志回放。
      const k = `${task.id}/${e.call}`
      if (!replayed.has(k)) replayed.set(k, await o.replay.traceOf(keyOf(task.id, sessionOf(task.workflow, e)), nonceOf(task.id, { id: e.call } as never)))
      for (const event of replayed.get(k)!) rows.push({ call: e.call, event })
    }
    return rows
  }

  const detail = async (id: string): Promise<TaskDetail | undefined> => {
    const task = o.store.get(id)
    if (task === undefined) return undefined
    const meta = o.store.meta(id)
    return {
      ...summaryOf(task), request: task.request, position: describePosition(task),
      ...(task.question === undefined ? {} : { question: task.question }),
      ...(task.failure === undefined ? {} : { failure: task.failure }),
      logPath: o.supervisor.logPath(id),
      repo: meta.repo, ...(meta.remote === undefined ? {} : { remote: meta.remote }), links: linksOf(task), branch: meta.branch, worktree: meta.worktree, baseSha: meta.baseSha, report: report(task), metrics: taskMetrics(task, Date.now(), o.store.createdAt(id)), trace: buildTrace(task, await traceRows(task)),
      runnerAlive: o.supervisor.running(id),
      ...(meta.conventions === undefined ? {} : { conventions: meta.conventions }),
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** 写接口的公共检查：同源、JSON、大小。通过时返回解析后的请求体。 */
  const guarded = async (req: IncomingMessage): Promise<{ body: Record<string, unknown> } | [number, { ok: false; error: string }]> => {
    if (req.headers.origin === undefined || req.headers.origin !== allowedOrigin(req)) {
      // 浏览器在外部地址上，Host 却是本机地址：反向代理把 Host 改写了。
      const rewritten = o.publicUrl !== undefined && req.headers.origin === o.publicUrl.origin
      return [403, { ok: false, error: rewritten ? `只接受来自本页面的请求：Origin 是 ${o.publicUrl!.origin}，Host 却是 ${req.headers.host ?? '（空）'}，反向代理要把原始 Host 传过来` : '只接受来自本页面的请求' }]
    }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return [415, { ok: false, error: '请求体必须是 JSON' }]
    const read = await readJson(req)
    if ('tooBig' in read) return [413, { ok: false, error: '请求体太大' }]
    const body = read.value
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? { body: body as Record<string, unknown> } : [400, { ok: false, error: '请求体必须是 JSON 对象' }]
  }

  const answer = (id: string, body: Record<string, unknown>): [number, AnswerResponse] => {
    if (typeof body.questionId !== 'string' || typeof body.text !== 'string') return [400, { ok: false, error: '需要 questionId 和 text' }]
    const task = o.store.get(id)
    if (task === undefined) return [404, { ok: false, error: `没有任务 ${id}` }]
    const step = o.store.dispatch(id, { kind: 'answered', questionId: body.questionId, text: body.text }, Date.now(), 'web')
    if (!step.accepted) return [409, { ok: false, error: step.reason ?? '回答没有被接受' }]
    // agent 中途的提问由正在等待的 runner 接着处理；对话尽头的问题回答后要有 runner 执行下一步。
    const resumeNeeded = task.question?.source === 'loop' && !o.supervisor.running(id)
    return [200, { ok: true, resumeNeeded }]
  }

  const create = async (body: Record<string, unknown>): Promise<[number, CreateResponse]> => {
    const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '')
    const created = await o.supervisor.create({ repo: field('repo'), workflow: field('workflow') || 'standard', request: field('request') })
    if (!created.ok) return [400, created]
    const started = o.supervisor.start(created.id)
    return started.ok ? [201, { ok: true, id: created.id }] : [500, { ok: false, error: started.error }]
  }

  /** 继续、重试、中止：都是对已有任务的操作。 */
  const act = (id: string, action: string): [number, ActionResponse] => {
    const task = o.store.get(id)
    if (task === undefined) return [404, { ok: false, error: `没有任务 ${id}` }]
    if (action === 'abort') {
      const step = o.store.dispatch(id, { kind: 'abort' }, Date.now(), 'web')
      return step.accepted ? [200, { ok: true }] : [409, { ok: false, error: step.reason ?? '无法中止' }]
    }
    if (action === 'retry') {
      const step = o.store.dispatch(id, { kind: 'retry' }, Date.now(), 'web')
      if (!step.accepted) return [409, { ok: false, error: step.reason ?? '无法重试' }]
    } else if (task.status !== 'running' && task.status !== 'waiting_user') {
      return [409, { ok: false, error: '只有进行中的任务可以继续' }]
    }
    const started = o.supervisor.start(id)
    return started.ok ? [200, { ok: true }] : [409, { ok: false, error: started.error }]
  }

  const workflows = (): WorkflowInfo[] =>
    o.supervisor.conventions.list('workflow').map(w => ({ name: w.name, version: w.version, ...(w.description === undefined ? {} : { description: w.description }), nodes: w.nodes }))

  const conventions = (): ConventionsResponse => ({
    workflows: workflows(), docs: o.supervisor.conventions.list('doc'),
    templates: o.supervisor.conventions.list('template'), skills: o.supervisor.conventions.list('skill'),
  })

  const convention = (kind: ConventionKind, name: string): ConventionDetail | undefined => {
    const versions = o.store.conventionHistory(kind, name)
    return versions.length === 0 ? undefined : { kind, name, versions }
  }

  const saveConvention = (kind: ConventionKind, name: string, body: Record<string, unknown>): [number, SaveConventionResponse] => {
    if (typeof body.content !== 'string') return [400, { ok: false, error: '需要 content' }]
    if (body.note !== undefined && typeof body.note !== 'string') return [400, { ok: false, error: 'note 必须是文字' }]
    if (body.validateOnly === true) {
      const errors = o.supervisor.conventions.validate(kind, name, body.content)
      return [200, errors.length === 0 ? { ok: true } : { ok: false, errors }]
    }
    const r = o.supervisor.conventions.save({ kind, name, content: body.content, ...(body.note === undefined ? {} : { note: body.note as string }), actor: 'web' }, Date.now())
    return r.ok ? [201, { ok: true, version: r.row.version }] : [400, { ok: false, errors: r.errors }]
  }

  const proposals = new Proposals(o.store, o.supervisor.conventions)
  const proposalInfo = (p: ProposalInfo): ProposalInfo => {
    const latest = o.store.latestVersion(p.target.kind, p.target.name)
    return { ...p, ...(latest === undefined ? {} : { latestVersion: latest }) }
  }
  const proposalDetail = (id: number): ProposalDetail | undefined => {
    const p = o.store.proposal(id)
    if (p === undefined) return undefined
    const base = o.store.convention(p.target.kind, p.target.name, p.baseVersion)
    // 证据原文：按当前的归纳规则对提案范围里的任务重新归纳，只留下提案引用的。任务日志只追加，id 指向的条目不变；
    // 但平台升级改了归纳规则（例如截断长度）时，文字可能和模型当时看到的略有不同。
    const cited = new Set(p.evidence)
    const samples = p.scope.tasks.flatMap(id => {
      const task = o.store.get(id)
      return task === undefined ? [] : [{ task, used: o.store.meta(id).conventions }]
    })
    const signals = evidence(samples).signals.filter(s => cited.has(s.id))
    const approved = p.events.find(e => e.status === 'approved')?.version
    const comparison = approved === undefined ? undefined : compare(compareSamples(p.target, approved, Date.now(), new Map()), p.target, approved)
    return { ...proposalInfo(p), ...(base === undefined ? {} : { base }), signals, ...(comparison === undefined ? {} : { comparison }) }
  }
  /** 前后对比用的样本：所有任务的指标（和统计页一样，失败后没人处理的只算到失败那一刻）和用到的约定版本。 */
  // 只为用到这个约定第 v-1 或 v 版的任务算指标（指标要重放整个日志）；metrics 按任务缓存，同一个请求里多条提案共用。
  type Loaded = { id: string; createdAt: number; task: CompareSample['task']; used: { used?: NonNullable<CompareSample['used']> } }
  /** 所有任务的状态和用到的约定版本，各读一次（同一个请求里多条提案共用）。 */
  const loadAll = (): Loaded[] => o.store.list().flatMap(s => {
    const task = o.store.get(s.id)
    if (task === undefined) return []
    const conventions = o.store.meta(s.id).conventions
    return [{ id: s.id, createdAt: s.createdAt, task, used: conventions === undefined ? {} : { used: conventions } }]
  })
  const compareSamples = (target: ProposalInfo['target'], version: number, now: number, metrics: Map<string, CompareSample['metrics']>, all: Loaded[] = loadAll()): CompareSample[] =>
    all.flatMap(s => {
      const { task, used } = s
      const v = versionUsed({ task, ...used }, target.kind, target.name)
      if (v === null || (v !== undefined && v !== version && v !== version - 1)) return []
      if (!metrics.has(s.id)) metrics.set(s.id, taskMetrics(task, sampleAt(task, now), s.createdAt))
      return [{ task, metrics: metrics.get(s.id)!, ...used }]
    })
  /** 每条已批准的提案：它生成的版本的前后对比，新的在前。 */
  const comparisons = (): ImprovementComparison[] => {
    const now = Date.now()
    const metrics = new Map<string, CompareSample['metrics']>()
    const approved = o.store.proposals().filter(p => p.events.some(e => e.status === 'approved'))
    const all = approved.length === 0 ? [] : loadAll()
    return approved.flatMap(p => {
      const e = p.events.find(x => x.status === 'approved')
      if (e?.version === undefined) return []
      return [{ proposal: { id: p.id, target: p.target, rationale: p.rationale, approvedAt: e.at }, comparison: compare(compareSamples(p.target, e.version, now, metrics, all), p.target, e.version) }]
    })
  }
  /** 失败原因 → 状态码。同一时间只跑一次生成由 generate 里的锁保证（命令行和网页共用）。 */
  const GENERATE_STATUS = { input: 400, busy: 409, config: 500, upstream: 502 } as const
  const startGenerate = async (body: Record<string, unknown>): Promise<[number, GenerateResponse]> => {
    if (o.improve === undefined) return [503, { ok: false, error: '这个服务没有配置生成提案用的执行器' }]
    if (typeof body.workflow !== 'string' || body.workflow.trim() === '') return [400, { ok: false, error: '需要 workflow' }]
    if (body.tasks !== undefined && !(Array.isArray(body.tasks) && body.tasks.every(t => typeof t === 'string'))) return [400, { ok: false, error: 'tasks 必须是任务 id 列表' }]
    {
      const tasks = (body.tasks as string[] | undefined)?.map(t => t.trim()).filter(t => t !== '')
      const r = await generate({
        store: o.store, conventions: o.supervisor.conventions, executor: o.improve.executor, dataDir: o.improve.dataDir,
        workflow: body.workflow.trim(), ...(tasks === undefined || tasks.length === 0 ? {} : { tasks }), actor: 'web', now: Date.now,
      })
      if (!r.ok) {
        const call = r.call === undefined ? {} : { call: { ...(r.call.model === undefined ? {} : { model: r.call.model }), usage: r.call.usage, ms: r.call.ms, replyHead: r.call.reply.slice(0, 500) } }
        return [GENERATE_STATUS[r.cause], { ok: false, error: r.error, ...call }]
      }
      return [200, { ok: true, created: r.created, refused: r.refused, ...(r.skipped === undefined ? {} : { skipped: r.skipped }),
        ...(r.call === undefined ? {} : { call: { ...(r.call.model === undefined ? {} : { model: r.call.model }), usage: r.call.usage, ms: r.call.ms } }) }]
    }
  }
  const decide = (id: number, action: string, body: Record<string, unknown>): [number, DecideResponse] => {
    const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined)
    if (body.note !== undefined && text('note') === undefined) return [400, { ok: false, error: 'note 必须是文字' }]
    if (action === 'reject' && (text('reason') ?? '').trim() === '') return [400, { ok: false, error: '拒绝需要写理由' }]
    const r = action === 'approve' ? proposals.approve(id, Date.now(), 'web', text('note')) : proposals.reject(id, Date.now(), 'web', text('reason')!)
    if (r.ok) return [200, { ok: true, proposal: r.row }]
    return [r.row === undefined ? 404 : 409, { ok: false, error: r.error }]
  }

  const credentialList = (): CredentialsResponse => ({
    usable: o.credentials.usable, ...(o.credentials.keyId === undefined ? { hint: GENERATE_HINT } : { keyId: o.credentials.keyId }), items: o.credentials.list(LOCAL_OWNER),
  })

  // 名字放在请求体里、不放进 URL：用户把值误填进名字时，值也不会进 URL 和访问记录。
  const saveCredential = (body: Record<string, unknown>): [number, SaveCredentialResponse] => {
    if (typeof body.name !== 'string') return [400, { ok: false, error: '需要 name（凭据名）' }]
    const name = body.name
    if (typeof body.value !== 'string') return [400, { ok: false, error: '需要 value（凭据的值）' }]
    if (typeof body.kind !== 'string' || !(CREDENTIAL_KINDS as readonly string[]).includes(body.kind)) return [400, { ok: false, error: `kind 只能是 ${CREDENTIAL_KINDS.join('、')}` }]
    // github-app. 开头的名字留给 GitHub App 的凭据：平台按这个名字找 App，放成别的类型会挡住 App 和令牌。
    if (name.startsWith('github-app.') !== (body.kind === 'github-app')) return [400, { ok: false, error: '名字以 github-app. 开头的凭据只能是 GitHub App 的凭据，GitHub App 的凭据名字也必须以 github-app. 开头' }]
    // github-user. 开头的名字留给 GitHub 的用户授权：只能在代码托管页授权得到，不能手填（手填的拿不到刷新令牌，也认不出是谁）。
    if (name.startsWith('github-user.') || body.kind === 'github-user') return [400, { ok: false, error: 'GitHub 的用户授权只能在代码托管页「用 GitHub 账号授权」得到，不能在这里填' }]
    if (o.credentials.list(LOCAL_OWNER).some(i => i.name === name && i.kind === 'github-app') && body.kind !== 'github-app') return [409, { ok: false, error: '这条是 GitHub App 的凭据，不能换成别的类型；要换就先删掉' }]
    const r = o.credentials.put(LOCAL_OWNER, name, body.kind as CredentialKind, body.value)
    return r.ok ? [200, r] : [o.credentials.usable ? 400 : 409, r]
  }

  // 清单流程注册 App：发起时记下一个随机的 state，托管平台跳回时原样带回；只认平台自己发起、没过期、没用过的 state。
  // 回调是浏览器从托管平台跳过来的 GET，没有 Origin 可查，state 就是它的同源证明（挡住别人诱导浏览器带着他自己的 code 来存凭据）。
  // 只存在内存里：平台重启后，进行中的注册要重新发起。
  // 用户授权（OAuth）沿用同一套 state，kind 区分是哪种流程：一种流程的 state 不能拿去完成另一种。
  const pending = new Map<string, { kind: 'register' | 'authorize'; name: string; expires: number; callbackUrl?: string }>()
  const appRegistrations = () => o.supervisor.forges.flatMap(f => (f.appRegistration === undefined ? [] : [f.appRegistration]))
  const callbackUrl = (req: IncomingMessage) => `${allowedOrigin(req)}${APP_CALLBACK}`
  const userCallbackUrl = (req: IncomingMessage) => `${allowedOrigin(req)}${USER_CALLBACK}`
  /** 发起一个流程：记下 state。进行中的太多时返回 undefined（不挤掉别人进行中的）。 */
  const begin = (kind: 'register' | 'authorize', name: string, callbackUrl?: string): string | undefined => {
    const now = Date.now()
    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k)
    if (pending.size >= 32) return undefined
    const state = randomBytes(32).toString('base64url')
    pending.set(state, { kind, name, expires: now + PENDING_MS, ...(callbackUrl === undefined ? {} : { callbackUrl }) })
    return state
  }
  /** 取出并作废 state（只能用一次，并发的第二次也拿不到）；不是这种流程的、过期的都当作没有。 */
  const finish = (kind: 'register' | 'authorize', state: string) => {
    const p = pending.get(state)
    pending.delete(state)
    return p !== undefined && p.kind === kind && p.expires > Date.now() ? p : undefined
  }
  /** App 凭据名对应的托管平台和它的用户授权。 */
  const userAuthOf = (appName: unknown) => {
    const forge = o.supervisor.forges.find(f => f.appRegistration?.credentialName === appName)
    return forge?.userAuthorization === undefined ? undefined : { app: forge.appRegistration!.credentialName, ua: forge.userAuthorization }
  }

  /** 这个 App 的用户授权现在的情况：谁授权了；不能发起授权时的原因。 */
  const userInfo = (appName: string, appValue: string | undefined, items: ReturnType<Credentials['list']>, callback: string): ForgeAppInfo['user'] => {
    const u = userAuthOf(appName)
    if (u === undefined) return undefined
    const saved = items.find(i => i.name === u.ua.credentialName)
    let authorized: NonNullable<ForgeAppInfo['user']>['authorized']
    if (saved !== undefined) {
      const got = o.credentials.get(LOCAL_OWNER, u.ua.credentialName)
      try {
        authorized = got.kind !== 'ok' ? { error: got.kind === 'error' ? got.error : '读不到' }
          : appValue !== undefined && !u.ua.matches(appValue, got.value) ? { error: '这条授权是给之前注册的那个 App 的，用不了：撤销后重新授权' }
          : { login: u.ua.read(got.value, Date.now()).login, updatedAt: saved.updatedAt }
      } catch (e) {
        authorized = { error: (e as Error).message }
      }
    }
    let unavailable: string | undefined
    if (appValue === undefined) unavailable = '先注册 App'
    else {
      try {
        u.ua.authorizeUrl(appValue, { callbackUrl: callback, state: 'check' })
      } catch (e) {
        unavailable = (e as Error).message
      }
    }
    return { ...(authorized === undefined ? {} : { authorized }), ...(unavailable === undefined ? {} : { unavailable }) }
  }

  const forgeApps = (req: IncomingMessage): ForgeAppsResponse => {
    const items = o.credentials.list(LOCAL_OWNER)
    return {
      usable: o.credentials.usable, ...(o.credentials.usable ? {} : { hint: GENERATE_HINT }), callbackUrl: callbackUrl(req),
      apps: appRegistrations().map(a => {
        // 和发起注册时的判断一致：这个名字已经有凭据（不管能不能读出来），就算已注册，不再给注册表单。
        const saved = items.find(i => i.name === a.credentialName)
        const value = saved === undefined ? undefined : o.credentials.get(LOCAL_OWNER, a.credentialName)
        const appValue = value?.kind === 'ok' ? value.value : undefined
        const user = userInfo(a.credentialName, appValue, items, userCallbackUrl(req))
        const base = { name: a.credentialName, host: a.host, appNameMax: a.appNameMax, ...(user === undefined ? {} : { user }) }
        if (saved === undefined) return base
        const installUrl = appValue === undefined ? undefined : a.installUrl(appValue)
        return { ...base, registered: { updatedAt: saved.updatedAt, ...(installUrl === undefined ? {} : { installUrl }) } }
      }),
    }
  }

  const registerApp = (req: IncomingMessage, body: Record<string, unknown>): [number, RegisterAppResponse] => {
    const reg = appRegistrations().find(a => a.credentialName === body.name)
    if (reg === undefined) return [400, { ok: false, error: '没有这个托管平台' }]
    const appName = typeof body.appName === 'string' ? body.appName.trim() : ''
    // 按字符数算（emoji 等算一个），和页面上的输入框一致。
    if (appName === '' || Array.from(appName).length > reg.appNameMax) return [400, { ok: false, error: `App 名字要 1 到 ${reg.appNameMax} 个字符` }]
    const org = typeof body.org === 'string' && body.org.trim() !== '' ? body.org.trim() : undefined
    if (org !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) return [400, { ok: false, error: `组织名不对：${org}` }]
    if (!o.credentials.usable) return [409, { ok: false, error: `平台没有主密钥，注册后存不了 App 的凭据。${GENERATE_HINT}` }]
    // 已经注册过：不悄悄换掉正在用的 App（换掉后，装了旧 App 的仓库都要重新安装）。
    if (o.credentials.list(LOCAL_OWNER).some(i => i.name === reg.credentialName)) return [409, { ok: false, error: `已经有凭据「${reg.credentialName}」；要换一个 App，先在凭据页删掉它` }]
    // 不挤掉进行中的注册：挤掉后，那个人在托管平台上建好的 App 回来时会被拒，成了没人用的 App。
    const state = begin('register', reg.credentialName, userCallbackUrl(req))
    if (state === undefined) return [429, { ok: false, error: '进行中的注册太多了，过半小时再试' }]
    return [200, { ok: true, ...reg.form({ appName, origin: allowedOrigin(req)!, callbackUrl: callbackUrl(req), userCallbackUrl: userCallbackUrl(req), state, ...(org === undefined ? {} : { org }) }) }]
  }

  /** 托管平台跳回来：核对 state，用 code 换 App 的凭据存起来，再跳回页面，结果放在页面地址里。 */
  const appCallback = async (url: URL): Promise<string> => {
    const back = (q: Record<string, string>) => `/#/forges?${new URLSearchParams(q)}`
    const p = finish('register', url.searchParams.get('state') ?? '')
    if (p === undefined) {
      // 带着 code 回来，说明托管平台那边已经建好了 App，只是这边认不出这次注册：提醒去删掉，免得留下没人用的 App。
      const orphan = url.searchParams.has('code') ? '。如果你刚在托管平台上确认了注册，那边已经建好了一个 App：到托管平台的 App 设置里删掉它' : ''
      return back({ error: `这次注册不是从本页面发起的，或者已经过期、已经用过（发起后 ${PENDING_MS / 60_000} 分钟内有效，平台重启后失效）：在本页面重新注册${orphan}` })
    }
    const code = url.searchParams.get('code') ?? ''
    if (!/^[\w-]{1,200}$/.test(code)) return back({ error: '托管平台没有带回 code（可能在那边取消了注册）：重新注册' })
    const reg = appRegistrations().find(a => a.credentialName === p.name)!
    let done
    try {
      done = await reg.complete(code, { userCallbackUrl: p.callbackUrl! })
    } catch (e) {
      return back({ error: (e as Error).message })
    }
    if (o.credentials.list(LOCAL_OWNER).some(i => i.name === reg.credentialName)) {
      return back({ error: `注册期间已经有了凭据「${reg.credentialName}」，没有覆盖它。${done.appUrl} 上新注册的 App 没有用上，可以在那里删掉` })
    }
    const r = o.credentials.put(LOCAL_OWNER, reg.credentialName, 'github-app', done.value)
    if (!r.ok) return back({ error: `${r.error}。${done.appUrl} 上新注册的 App 没有存下凭据，在那里删掉后重新注册` })
    return back({ registered: reg.credentialName, app: done.appName })
  }

  /** 发起用户授权（OAuth）：返回浏览器要去的托管平台授权页。已经有人授权时也可以再授权（换成新授权的人）。 */
  const authorizeUser = (req: IncomingMessage, body: Record<string, unknown>): [number, AuthorizeUserResponse] => {
    const u = userAuthOf(body.name)
    if (u === undefined) return [400, { ok: false, error: '没有这个托管平台，或者它不支持用户授权' }]
    if (!o.credentials.usable) return [409, { ok: false, error: `平台没有主密钥，存不了授权。${GENERATE_HINT}` }]
    const app = o.credentials.get(LOCAL_OWNER, u.app)
    if (app.kind !== 'ok') return [409, { ok: false, error: app.kind === 'error' ? app.error : '先注册 App，再用 GitHub 账号授权' }]
    const callback = userCallbackUrl(req)
    let url: string
    try {
      url = u.ua.authorizeUrl(app.value, { callbackUrl: callback, state: 'probe' })
    } catch (e) {
      return [409, { ok: false, error: (e as Error).message }]
    }
    const state = begin('authorize', u.app, callback)
    if (state === undefined) return [429, { ok: false, error: '进行中的授权太多了，过半小时再试' }]
    url = u.ua.authorizeUrl(app.value, { callbackUrl: callback, state })
    return [200, { ok: true, url }]
  }

  /** 托管平台授权完跳回来：核对 state，用 code 换令牌存起来，再跳回页面。 */
  const userCallback = async (url: URL): Promise<string> => {
    const back = (q: Record<string, string>) => `/#/forges?${new URLSearchParams(q)}`
    const p = finish('authorize', url.searchParams.get('state') ?? '')
    if (p === undefined) return back({ error: `这次授权不是从本页面发起的，或者已经过期、已经用过（发起后 ${PENDING_MS / 60_000} 分钟内有效，平台重启后失效）：在本页面重新授权` })
    const said = url.searchParams.get('error')
    if (said === 'access_denied') return back({ error: '在 GitHub 上取消了授权，平台没有存任何东西' })
    if (said !== null) return back({ error: `GitHub 没有完成授权：${said.slice(0, 100)}${url.searchParams.has('error_description') ? `（${(url.searchParams.get('error_description') ?? '').slice(0, 300)}）` : ''}` })
    const code = url.searchParams.get('code') ?? ''
    if (!/^[\w-]{1,200}$/.test(code)) return back({ error: '托管平台没有带回 code：重新授权' })
    const u = userAuthOf(p.name)!
    const app = o.credentials.get(LOCAL_OWNER, u.app)
    if (app.kind !== 'ok') return back({ error: '授权期间 App 的凭据被删掉了：重新注册 App 后再授权' })
    let done
    try {
      done = await u.ua.complete(app.value, { code, callbackUrl: p.callbackUrl! }, Date.now())
    } catch (e) {
      return back({ error: (e as Error).message })
    }
    const r = o.credentials.put(LOCAL_OWNER, u.ua.credentialName, 'github-user', done.value)
    if (!r.ok) return back({ error: r.error })
    return back({ authorized: done.login })
  }

  /** 撤销用户授权：先在托管平台上撤销，再删掉平台存的令牌。托管平台那边撤销失败时照样删掉，并提醒去托管平台上撤销。 */
  const revokeUser = async (body: Record<string, unknown>): Promise<[number, RevokeUserResponse]> => {
    const u = userAuthOf(body.name)
    if (u === undefined) return [400, { ok: false, error: '没有这个托管平台，或者它不支持用户授权' }]
    const user = o.credentials.get(LOCAL_OWNER, u.ua.credentialName)
    if (user.kind === 'absent') return [404, { ok: false, error: '没有人授权过' }]
    const app = o.credentials.get(LOCAL_OWNER, u.app)
    let warning: string | undefined
    if (user.kind === 'ok' && app.kind === 'ok') {
      const manual = '平台已经删掉了这个授权；到 GitHub 的「Settings → Applications → Authorized GitHub Apps」里撤销它'
      // 令牌过期了 GitHub 就不认它，撤销不掉：先续期，用新令牌撤销（续期得到的新令牌随授权一起作废，不用存）。
      let value: string | undefined = user.value
      if (u.ua.read(value, Date.now()).refresh) {
        try {
          value = await u.ua.refresh(app.value, value, Date.now())
        } catch {
          value = undefined
          warning = `授权的令牌已经过期，续期也没成功，没能在 GitHub 上撤销：${manual}`
        }
      }
      if (value !== undefined) {
        try {
          await u.ua.revoke(app.value, value)
        } catch (e) {
          warning = `${(e as Error).message}：${manual}`
        }
      }
    } else {
      warning = '平台读不出授权或 App 的凭据，没能在 GitHub 上撤销：到 GitHub 的「Settings → Applications → Authorized GitHub Apps」里撤销它'
    }
    o.credentials.delete(LOCAL_OWNER, u.ua.credentialName)
    return [200, { ok: true, ...(warning === undefined ? {} : { warning }) }]
  }

  const deleteCredential = (body: Record<string, unknown>): [number, DeleteCredentialResponse] => {
    if (typeof body.name !== 'string') return [400, { ok: false, error: '需要 name（凭据名）' }]
    return o.credentials.delete(LOCAL_OWNER, body.name) ? [200, { ok: true }] : [404, { ok: false, error: '没有这条凭据' }]
  }

  const root = resolve(o.staticDir)
  const serveStatic = (path: string, res: ServerResponse) => {
    const file = normalize(join(root, path))
    const inside = file === root || file.startsWith(root + sep)
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(root, 'index.html')
    if (!existsSync(target)) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('前端还没有构建：先运行 npm run build:web')
    }
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream' })
    res.end(readFileSync(target))
  }

  return createServer(async (req, res) => {
    try {
      if (allowedOrigin(req) === undefined) return json(res, 421, { error: o.publicUrl === undefined ? '只接受通过本机地址访问' : `只接受通过本机地址或 ${o.publicUrl.origin} 访问` })
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'POST') {
        const action = /^\/api\/tasks\/([\w-]+)\/(answer|resume|retry|abort)$/.exec(url.pathname)
        const conv = CONVENTION.exec(url.pathname)
        const dec = DECIDE.exec(url.pathname)
        const gen = url.pathname === '/api/improve/generate'
        const cred = url.pathname === '/api/credentials' ? 'save' : url.pathname === '/api/credentials/delete' ? 'delete' : undefined
        const reg = url.pathname === '/api/forge-apps/register'
        const userAction = url.pathname === '/api/forge-apps/authorize' ? 'authorize' : url.pathname === '/api/forge-apps/revoke' ? 'revoke' : undefined
        if (url.pathname !== '/api/tasks' && action === null && conv === null && dec === null && !gen && cred === undefined && !reg && userAction === undefined) return json(res, 404, { error: '没有这个接口' })
        const g = await guarded(req)
        if (Array.isArray(g)) return json(res, ...g)
        if (reg) return json(res, ...registerApp(req, g.body))
        if (userAction === 'authorize') return json(res, ...authorizeUser(req, g.body))
        if (userAction === 'revoke') return json(res, ...(await revokeUser(g.body)))
        if (cred !== undefined) return json(res, ...(cred === 'save' ? saveCredential(g.body) : deleteCredential(g.body)))
        if (gen) return json(res, ...(await startGenerate(g.body)))
        if (dec !== null) return json(res, ...decide(Number(dec[1]), dec[2]!, g.body))
        if (conv !== null) {
          const name = decodeName(conv[2]!)
          return name === undefined ? json(res, 400, { ok: false, error: '名字的 URL 编码不对' }) : json(res, ...saveConvention(conv[1] as ConventionKind, name, g.body))
        }
        if (action === null) return json(res, ...(await create(g.body)))
        return json(res, ...(action[2] === 'answer' ? answer(action[1]!, g.body) : act(action[1]!, action[2]!)))
      }
      if (req.method !== 'GET') return json(res, 405, { error: '不支持的请求' })
      if (url.pathname === '/api/workflows') return json(res, 200, workflows())
      if (url.pathname === '/api/conventions') return json(res, 200, conventions())
      if (url.pathname === '/api/credentials') return json(res, 200, credentialList())
      if (url.pathname === '/api/forge-apps') return json(res, 200, forgeApps(req))
      if (url.pathname === APP_CALLBACK || url.pathname === USER_CALLBACK) {
        const location = url.pathname === APP_CALLBACK ? await appCallback(url) : await userCallback(url)
        res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        return void res.end()
      }
      const conv = CONVENTION.exec(url.pathname)
      if (conv) {
        const name = decodeName(conv[2]!)
        const d = name === undefined ? undefined : convention(conv[1] as ConventionKind, name)
        return d === undefined ? json(res, 404, { error: `没有约定「${name ?? conv[2]}」` }) : json(res, 200, d)
      }
      if (url.pathname === '/api/tasks') return json(res, 200, o.store.list())
      if (url.pathname === '/api/improve/proposals') return json(res, 200, o.store.proposals().map(proposalInfo))
      if (url.pathname === '/api/improve/comparisons') return json(res, 200, comparisons())
      const prop = PROPOSAL.exec(url.pathname)
      if (prop) {
        const d = proposalDetail(Number(prop[1]))
        return d === undefined ? json(res, 404, { error: `没有提案 #${prop[1]}` }) : json(res, 200, d)
      }
      if (url.pathname === '/api/insights') {
        const now = Date.now()
        const samples = o.store.list().flatMap(s => {
          const task = o.store.get(s.id)
          return task === undefined ? [] : [{ task, metrics: taskMetrics(task, sampleAt(task, now), s.createdAt) }]
        })
        return json(res, 200, insights(samples))
      }
      const lg = /^\/api\/tasks\/([\w-]+)\/log$/.exec(url.pathname)
      if (lg) {
        if (o.store.get(lg[1]!) === undefined) return json(res, 404, { error: `没有任务 ${lg[1]}` })
        // 日志在平台所在的机器上：浏览器里直接看，团队成员不用登录服务器。只返回最后 LOG_TAIL 字节。
        const path = o.supervisor.logPath(lg[1]!)
        const text = existsSync(path) ? tail(path, LOG_TAIL) : `（还没有日志：${path}）\n`
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        return void res.end(text)
      }
      const ch = /^\/api\/tasks\/([\w-]+)\/changes(\/diff)?$/.exec(url.pathname)
      if (ch) {
        if (o.store.get(ch[1]!) === undefined) return json(res, 404, { error: `没有任务 ${ch[1]}` })
        const meta = o.store.meta(ch[1]!)
        try {
          if (ch[2] === undefined) return json(res, 200, committedChanges(meta) satisfies TaskChanges)
          // 单个文件的 diff：head 来自改动列表，只接受任务分支上的提交。
          const head = url.searchParams.get('head') ?? ''
          const path = url.searchParams.get('path') ?? ''
          if (!onBranch(meta, head)) return json(res, 400, { error: '提交不在任务分支上，刷新页面后再试' })
          const d = fileDiff(meta, head, path)
          return d === undefined ? json(res, 404, { error: `这个提交里没有改动文件 ${path}` }) : json(res, 200, d satisfies FileDiff)
        } catch (e) {
          return json(res, 500, { error: `读不到改动（worktree ${meta.worktree}）：${String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim().split('\n')[0]}` })
        }
      }
      const m = /^\/api\/tasks\/([\w-]+)$/.exec(url.pathname)
      if (m) {
        const d = await detail(m[1]!)
        return d === undefined ? json(res, 404, { error: `没有任务 ${m[1]}` }) : json(res, 200, d)
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '没有这个接口' })
      return serveStatic(url.pathname, res)
    } catch (e) {
      return json(res, 500, { error: (e as Error).message })
    }
  })
}
