// Web 服务：JSON 接口 + 前端静态文件。只监听本机地址；第一版没有登录。
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { describePosition, sessionOf } from '../engine/machine.ts'
import { report } from '../engine/report.ts'
import type { Task } from '../engine/types.ts'
import type { Executor } from '../executor/types.ts'
import { keyOf, nonceOf } from '../runner/runner.ts'
import type { Store } from '../store/store.ts'
import { buildTrace } from '../trace/build.ts'
import type { TraceEvent } from '../trace/types.ts'
import type { TaskDetail } from './types.ts'

const summaryOf = (t: Task) => ({ id: t.id, status: t.status, workflow: t.workflow.name })

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }

export const createWebServer = (o: { store: Store; replay: Pick<Executor, 'traceOf'>; staticDir: string }): Server => {
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
    }
  }

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const root = resolve(o.staticDir)
  const serveStatic = (path: string, res: import('node:http').ServerResponse) => {
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
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method !== 'GET') return json(res, 405, { error: '只支持 GET' })
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
