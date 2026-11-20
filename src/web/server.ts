// Web 服务：JSON 接口 + 前端静态文件。只监听本机地址；第一版没有登录。
// 写接口（新建任务、回答、继续、重试、中止）都要求 JSON 请求体和同源 Origin，挡住其他网页向 127.0.0.1 发的跨站请求。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { describePosition, sessionOf } from '../engine/machine.ts'
import { report } from '../engine/report.ts'
import type { Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import { keyOf, nonceOf } from '../runner/runner.ts'
import type { Supervisor } from '../runner/supervisor.ts'
import type { Store } from '../store/store.ts'
import { buildTrace } from '../trace/build.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { ConventionKind } from '../store/types.ts'
import type { ActionResponse, AnswerResponse, ConventionDetail, ConventionsResponse, CreateResponse, SaveConventionResponse, TaskDetail, WorkflowInfo } from './types.ts'

/** /api/conventions/<workflow|doc>/<名字>，名字可以是中文（URL 编码）。 */
const CONVENTION = /^\/api\/conventions\/(workflow|doc)\/([^/]+)$/

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
 * Host 必须是本机地址加本服务的端口。挡住 DNS 重绑定：攻击者的域名解析到 127.0.0.1 时，
 * Origin 和 Host 都是攻击者的域名、彼此一致，只比较两者挡不住，所以先限定 Host 本身。
 */
const localHost = (req: IncomingMessage): boolean => {
  const port = req.socket.localPort
  return ['127.0.0.1', 'localhost', '[::1]'].some(h => req.headers.host === `${h}:${port}`)
}

/** 浏览器发来的同源请求：Origin 必须存在且与 Host 一致。 */
const sameOrigin = (req: IncomingMessage): boolean => {
  const origin = req.headers.origin
  return origin !== undefined && req.headers.host !== undefined && origin === `http://${req.headers.host}`
}

export const createWebServer = (o: { store: Store; supervisor: Supervisor; replay: Pick<Executor, 'traceOf'>; staticDir: string }): Server => {
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
      branch: meta.branch, worktree: meta.worktree, report: report(task), trace: buildTrace(task, await traceRows(task)),
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
    if (!sameOrigin(req)) return [403, { ok: false, error: '只接受来自本页面的请求' }]
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
    const created = o.supervisor.create({ repo: field('repo'), workflow: field('workflow') || 'feature', request: field('request') })
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

  const conventions = (): ConventionsResponse => ({ workflows: workflows(), docs: o.supervisor.conventions.list('doc') })

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
      if (!localHost(req)) return json(res, 421, { error: '只接受通过本机地址访问' })
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'POST') {
        const action = /^\/api\/tasks\/([\w-]+)\/(answer|resume|retry|abort)$/.exec(url.pathname)
        const conv = CONVENTION.exec(url.pathname)
        if (url.pathname !== '/api/tasks' && action === null && conv === null) return json(res, 404, { error: '没有这个接口' })
        const g = await guarded(req)
        if (Array.isArray(g)) return json(res, ...g)
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
