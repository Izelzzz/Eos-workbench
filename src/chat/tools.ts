// 对话 agent 的只读工具：读平台的工作流、约定文档、Agent 模板、技能、任务和任务的状态、trace、指标、改动摘要。
// 一张表列出全部工具：没有写操作，也没有读凭据、读仓库文件的工具（改动只给文件列表和增删行数）。
// 任务的 trace 和产出里可能带着任务 agent 读过的代码片段：trace 在读取范围内，这些片段跟着 trace 一起返回（截断、遮蔽）。
// 参数在这里（边界）按 schema 解析；每个工具的返回都先截断、再遮蔽已知凭据值，才交给 agent。
import { z } from 'zod'
import type { Conventions } from '../conventions/conventions.ts'
import { describePosition } from '../engine/machine.ts'
import { taskMetrics } from '../engine/metrics.ts'
import type { Task } from '../engine/types.ts'
import type { TaskChanges } from '../runner/changes.ts'
import type { Store } from '../store/store.ts'
import type { ConventionKind } from '../store/types.ts'
import type { TraceEvent } from '../trace/types.ts'

/** 一个工具返回给 agent 的最多字数：trace、产出可能很长，超出部分截掉并注明。 */
export const MAX_OUTPUT_CHARS = 20_000
/** 列表里每段长文字（任务产出、回复、工具输出）保留的字数。 */
const SNIPPET = 600
const LIST_LIMIT = 50

export type DataSource = {
  store: Store
  conventions: Conventions
  /** 任务分支相对基线的改动文件列表（不含 diff 内容）。 */
  changes: (taskId: string) => TaskChanges
  now: () => number
}

const KINDS = ['workflow', 'doc', 'template', 'skill'] as const satisfies readonly ConventionKind[]
const KIND_NAMES: Record<ConventionKind, string> = { workflow: '工作流', doc: '约定文档', template: 'Agent 模板', skill: '技能' }

const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n)}…（共 ${s.length} 字，后面省略）`)

/** 工具运行时的上下文。clip 先遮蔽再截断：先截断的话，截断处可能留下半截凭据，遮蔽认不出来。 */
type Ctx = DataSource & { clip: (s: string, n?: number) => string }

type Tool<S extends z.ZodType> = { name: string; description: string; input: S; run: (d: Ctx, args: z.infer<S>) => unknown }
const tool = <S extends z.ZodType>(t: Tool<S>): Tool<z.ZodType> => t as unknown as Tool<z.ZodType>

const taskOr = (d: Ctx, id: string): Task => {
  const t = d.store.get(id)
  if (t === undefined) throw new ToolError(`没有任务 ${id}`)
  return t
}

export class ToolError extends Error {}

const taskId = z.string().regex(/^[\w-]{1,64}$/, '任务 id 只含字母、数字、下划线和连字符')

/** 一次调用的 trace 摘要：属于哪个节点和角色、用了哪些工具、用量、最后的回复开头。 */
const callSummary = (clip: Ctx['clip'], call: string, events: TraceEvent[]) => {
  const start = events.find(e => e.kind === 'call_start')
  const models = events.flatMap(e => (e.kind === 'model' ? [e] : []))
  return {
    call,
    ...(start?.kind === 'call_start' && start.call !== undefined ? { node: start.call.node, role: start.call.role, purpose: start.call.purpose } : {}),
    steps: models.length,
    tools: [...new Set(events.flatMap(e => (e.kind === 'tool_start' ? [e.name] : [])))],
    toolErrors: events.filter(e => e.kind === 'tool_end' && e.isError).length,
    lastText: clip(
      models
        .map(m => m.text)
        .filter(t => t.trim() !== '')
        .at(-1) ?? '',
    ),
  }
}

const eventView = (clip: Ctx['clip'], e: TraceEvent) => {
  switch (e.kind) {
    case 'call_start':
      return { kind: e.kind, t: e.t, ...(e.call === undefined ? {} : { node: e.call.node, role: e.call.role, purpose: e.call.purpose, prompt: clip(e.call.prompt, 2000) }) }
    case 'model':
      return { kind: e.kind, t: e.t, step: e.step, usage: e.usage, text: clip(e.text, 2000), reasoning: clip(e.reasoning), toolCalls: e.toolCalls.map(c => ({ name: c.name, args: clip(c.args) })) }
    case 'tool_start':
      return { kind: e.kind, t: e.t, name: e.name, args: clip(e.args) }
    case 'tool_end':
      return { kind: e.kind, t: e.t, isError: e.isError, output: clip(e.output, 1500) }
    default:
      return e
  }
}

export const TOOLS: Tool<z.ZodType>[] = [
  tool({
    name: 'list_conventions',
    description: '列出平台上的团队约定：工作流、约定文档（doc）、Agent 模板（template）、技能（skill），每个有最新版本号和说明。',
    input: z.object({ kind: z.enum(KINDS) }),
    run: (d, a) => ({ kind: KIND_NAMES[a.kind], items: d.conventions.list(a.kind as 'doc') }),
  }),
  tool({
    name: 'get_convention',
    description: '读一个团队约定的完整内容（YAML 或 Markdown）。不给 version 就是正在使用的最新版本。',
    input: z.object({ kind: z.enum(KINDS), name: z.string().min(1).max(128), version: z.number().int().positive().optional() }),
    run: (d, a) => {
      const row = d.store.convention(a.kind, a.name, a.version)
      if (row === undefined) throw new ToolError(`没有${KIND_NAMES[a.kind]}「${a.name}」${a.version === undefined ? '' : `的第 ${a.version} 版`}`)
      return { kind: KIND_NAMES[row.kind], name: row.name, version: row.version, note: row.note, actor: row.actor, createdAt: row.createdAt, content: row.content }
    },
  }),
  tool({
    name: 'convention_history',
    description: '一个团队约定的所有版本（新的在前）：版本号、修改说明、操作人、时间，不含内容。',
    input: z.object({ kind: z.enum(KINDS), name: z.string().min(1).max(128) }),
    run: (d, a) => d.store.conventionHistory(a.kind, a.name).map(r => ({ version: r.version, note: r.note, actor: r.actor, createdAt: r.createdAt })),
  }),
  tool({
    name: 'list_tasks',
    description: '任务列表（新的在前）：id、状态、需求、工作流、创建和更新时间。可以按状态、工作流筛选。',
    input: z.object({
      status: z.enum(['running', 'waiting_user', 'done', 'failed', 'aborted']).optional(),
      workflow: z.string().max(128).optional(),
      limit: z.number().int().min(1).max(LIST_LIMIT).optional(),
    }),
    run: (d, a) =>
      d.store
        .list()
        .filter(t => (a.status === undefined || t.status === a.status) && (a.workflow === undefined || t.workflow === a.workflow))
        .slice(0, a.limit ?? 20)
        .map(t => ({ ...t, request: d.clip(t.request, 300) })),
  }),
  tool({
    name: 'get_task',
    description: '一个任务的状态：需求、工作流、当前位置、失败原因、待回答的问题、每个节点的产出（截断）、用到的约定版本，以及按时间的记录摘要。',
    input: z.object({ id: taskId }),
    run: (d, a) => {
      const t = taskOr(d, a.id)
      const meta = d.store.meta(a.id)
      return {
        id: t.id,
        status: t.status,
        request: t.request,
        workflow: { name: t.workflow.name, nodes: t.workflow.nodes.map(n => ({ id: n.id, kind: n.kind })) },
        position: describePosition(t),
        ...(t.failure === undefined ? {} : { failure: t.failure }),
        ...(t.question === undefined ? {} : { question: { text: t.question.text, options: t.question.options } }),
        outputs: Object.fromEntries(Object.entries(t.outputs).map(([k, v]) => [k, d.clip(v ?? '', 1500)])),
        conventions: meta.conventions,
        branch: meta.branch,
        ...(meta.remote === undefined ? {} : { remote: meta.remote }),
        log: t.log.map(e => {
          switch (e.type) {
            case 'call':
              return { type: e.type, at: e.at, node: e.node, role: e.role, purpose: e.purpose, round: e.round, reply: d.clip(e.reply), usage: e.usage, ms: e.ms }
            case 'check':
              return { type: e.type, at: e.at, node: e.node, results: e.results.map(r => ({ check: r.check, passed: r.passed, detail: d.clip(r.detail, 300) })) }
            case 'question':
              return { type: e.type, at: e.at, text: d.clip(e.question.text, 300) }
            case 'answer':
              return { type: e.type, at: e.at, text: d.clip(e.text, 300) }
            case 'note':
              return { type: e.type, at: e.at, node: e.node, text: d.clip(e.text, 300) }
          }
        }),
      }
    },
  }),
  tool({
    name: 'get_task_trace',
    description: '一个任务的 trace。不给 call：列出每次 agent 调用的摘要（节点、角色、用途、用了哪些工具、最后的回复开头）。给 call：这次调用的事件（模型输出、工具调用和结果，长内容截断）。',
    input: z.object({ id: taskId, call: z.string().max(64).optional() }),
    run: (d, a) => {
      taskOr(d, a.id)
      const rows = d.store.trace(a.id)
      const byCall = new Map<string, TraceEvent[]>()
      for (const r of rows) byCall.set(r.call, [...(byCall.get(r.call) ?? []), r.event])
      if (a.call === undefined) return [...byCall].map(([call, events]) => callSummary(d.clip, call, events))
      const events = byCall.get(a.call)
      if (events === undefined) throw new ToolError(`任务 ${a.id} 没有调用 ${a.call} 的 trace`)
      return events.map(e => eventView(d.clip, e))
    },
  }),
  tool({
    name: 'get_task_metrics',
    description: '一个任务的指标：每个阶段的调用次数、token 用量、agent 时长、检查时长、等用户和阻塞的时间，以及按角色的汇总。',
    input: z.object({ id: taskId }),
    run: (d, a) => taskMetrics(taskOr(d, a.id), d.now(), d.store.createdAt(a.id)),
  }),
  tool({
    name: 'get_task_changes',
    description: '一个任务分支相对基线的改动摘要：改了哪些文件、每个文件增删多少行。不含文件内容和 diff。',
    input: z.object({ id: taskId }),
    run: (d, a) => {
      taskOr(d, a.id)
      try {
        return d.changes(a.id)
      } catch (e) {
        throw new ToolError(`读不到任务 ${a.id} 的改动：${String((e as Error).message).split('\n')[0]}`)
      }
    },
  }),
]

/** 发给 agent 的工具表（MCP 的 tools/list）。 */
export const toolList = () => TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.input) }))

export type ToolOutcome = { text: string; isError: boolean }

/** 执行一个工具：解析参数、运行、截断、遮蔽。出错时把原因（同样遮蔽过）返回给 agent，不抛出。 */
export const callTool = (d: DataSource, redact: (s: string) => string, name: string, args: unknown): ToolOutcome => {
  const t = TOOLS.find(x => x.name === name)
  if (t === undefined) return { text: redact(`没有工具 ${name}`), isError: true }
  const parsed = t.input.safeParse(args ?? {})
  if (!parsed.success) return { text: redact(`参数不对：${parsed.error.issues.map(i => `${i.path.join('.') || '(参数)'}：${i.message}`).join('；')}`), isError: true }
  try {
    const ctx: Ctx = { ...d, clip: (s, n = SNIPPET) => cut(redact(s), n) }
    // 整段再遮蔽一次（没经过 clip 的字段），然后才截断。
    const out = redact(JSON.stringify(t.run(ctx, parsed.data), null, 1))
    const text = out.length <= MAX_OUTPUT_CHARS ? out : `${out.slice(0, MAX_OUTPUT_CHARS)}\n…（返回共 ${out.length} 字，超过 ${MAX_OUTPUT_CHARS} 字的部分省略；可以缩小范围再读）`
    return { text, isError: false }
  } catch (e) {
    return { text: redact(e instanceof ToolError ? e.message : `读取出错：${(e as Error).message}`), isError: true }
  }
}
