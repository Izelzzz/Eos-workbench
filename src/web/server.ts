// Web 服务：JSON 接口 + 前端静态文件。默认只监听本机地址；第一版没有登录。
// 写接口（新建任务、回答、继续、重试、中止）都要求 JSON 请求体和同源 Origin，挡住其他网页向本服务发的跨站请求。
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { describePosition, sessionOf } from '../engine/machine.ts'
import { insights, sampleAt } from '../engine/insights.ts'
import { taskMetrics } from '../engine/metrics.ts'
import { report } from '../engine/report.ts'
import type { Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import { generate } from '../improve/generate.ts'
import { Proposals } from '../improve/proposals.ts'
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
  ActionResponse, AnswerResponse, ConventionDetail, ConventionsResponse, CreateResponse, DecideResponse, GenerateResponse, ImprovementComparison, ProposalDetail, ProposalInfo, FileDiff, SaveConventionResponse, TaskChanges, TaskDetail, WorkflowInfo,
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
  if (publicUrl === undefined || /[/?#@\\]/.test(host)) return undefined
  // 按外部地址的协议规范化：反向代理可能传来大写或带默认端口（eos.example.com:443）的 Host。
  let normalized: string
  try {
    normalized = new URL(`${publicUrl.protocol}//${host}`).host
  } catch {
    return undefined
  }
  return normalized === publicUrl.host ? publicUrl.origin : undefined
}

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
/** publicUrl：外部地址，见 parsePublicUrl；不给时只接受本机地址。 */
export const createWebServer = (o: { store: Store; supervisor: Supervisor; replay: Pick<Executor, 'traceOf'>; staticDir: string; improve?: { executor: Executor; dataDir: string }; publicUrl?: URL }): Server => {
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
      repo: meta.repo, branch: meta.branch, worktree: meta.worktree, baseSha: meta.baseSha, report: report(task), metrics: taskMetrics(task, Date.now(), o.store.createdAt(id)), trace: buildTrace(task, await traceRows(task)),
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
    if (req.headers.origin === undefined || req.headers.origin !== allowedOrigin(req)) return [403, { ok: false, error: '只接受来自本页面的请求' }]
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

  const create = (body: Record<string, unknown>): [number, CreateResponse] => {
    const field = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '')
    const created = o.supervisor.create({ repo: field('repo'), workflow: field('workflow') || 'standard', request: field('request') })
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
        if (url.pathname !== '/api/tasks' && action === null && conv === null && dec === null && !gen) return json(res, 404, { error: '没有这个接口' })
        const g = await guarded(req)
        if (Array.isArray(g)) return json(res, ...g)
        if (gen) return json(res, ...(await startGenerate(g.body)))
        if (dec !== null) return json(res, ...decide(Number(dec[1]), dec[2]!, g.body))
        if (conv !== null) {
          const name = decodeName(conv[2]!)
          return name === undefined ? json(res, 400, { ok: false, error: '名字的 URL 编码不对' }) : json(res, ...saveConvention(conv[1] as ConventionKind, name, g.body))
        }
        if (action === null) return json(res, ...create(g.body))
        return json(res, ...(action[2] === 'answer' ? answer(action[1]!, g.body) : act(action[1]!, action[2]!)))
      }
      if (req.method !== 'GET') return json(res, 405, { error: '不支持的请求' })
      if (url.pathname === '/api/workflows') return json(res, 200, workflows())
      if (url.pathname === '/api/conventions') return json(res, 200, conventions())
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
