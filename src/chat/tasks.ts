// 对话 agent 提议建任务：agent 给出仓库、工作流、需求，平台检查后记成「待确认」的任务提议。
// 提议不建任务：这里只写 chat_task_proposals 表。建任务只能由人确认（命令行 eos chat create，或网页），见 create.ts；
// agent 能触发的模块都不引用 create.ts（tests/chat-tasks.test.ts 核对）。
// 仓库只能是平台上的任务用过的（list_repos 列出的）：agent 不能拿任意路径试探服务器上有什么。别的仓库由人在确认时改。
import { z } from 'zod'
import type { Store } from '../store/store.ts'
import type { ToolOutcome } from './tools.ts'
import type { TaskProposal } from './types.ts'

export const PROPOSE_TASK_TOOL = 'propose_task'
/** 一次调用里最多记几条任务提议。 */
export const MAX_TASK_PROPOSALS_PER_CALL = 5
export const MAX_REQUEST_CHARS = 20_000

/**
 * 控制字符（换行、制表符以外）不收：命令行原样打印提议，终端的控制序列能把一部分需求擦掉或盖住，人看到的就不是任务会拿到的。
 * 标题、仓库、工作流是一行，换行也不收。
 */
/** 码点是不是控制字符：C0（allowLine 时放过换行和制表符）、DEL、C1。 */
const hasControl = (s: string, allowLine: boolean): boolean =>
  [...s].some(ch => {
    const c = ch.codePointAt(0)!
    if (allowLine && (c === 0x0a || c === 0x09)) return false
    return c < 0x20 || (c >= 0x7f && c <= 0x9f)
  })
const line = (max: number) => z.string().min(1).max(max).refine(s => !hasControl(s, false), '不能有换行和控制字符')
const input = z.object({
  title: line(80),
  repo: line(512),
  workflow: line(64),
  request: z.string().min(1).max(MAX_REQUEST_CHARS).refine(s => !hasControl(s, true), '不能有控制字符（换行、制表符以外）'),
})

export const proposeTaskToolSpec = () => ({
  name: PROPOSE_TASK_TOOL,
  description:
    '提议新建一个任务：title 是一句话的标题；repo 必须是 list_repos 列出的仓库之一（原样照抄）；workflow 是平台上已有的工作流名字；request 是交给任务的完整需求。' +
    '平台会检查，不通过会返回错误，改了再提。通过的提议只是记下来，不会建任务：要等用户确认（用户可以改这三项）后才创建。用户要用列表里没有的仓库时，照样提议一个最接近的，并在回复里请用户在确认时改仓库。',
  inputSchema: z.toJSONSchema(input),
})

/**
 * 平台上的任务用过的仓库，最近用过的在前：远程仓库是网页地址，本机仓库是路径。这两种写法建任务时都认。
 * 远程仓库的名字不分大小写（GitHub 是这样），按小写合并，用最近一次的写法。
 */
export const usedRepos = (store: Store): { repo: string; tasks: number; lastUsedAt: number }[] => {
  const seen = new Map<string, { repo: string; tasks: number; lastUsedAt: number }>()
  for (const r of store.taskRepos()) {
    const repo = r.remote ?? r.repo
    const key = r.remote === undefined ? repo : repo.toLowerCase()
    const row = seen.get(key)
    if (row === undefined) seen.set(key, { repo, tasks: 1, lastUsedAt: r.createdAt })
    else row.tasks++
  }
  return [...seen.values()]
}

/** 任务提议要的检查：用过的仓库，以及工作流能不能用来建任务（不能用时返回原因）。没有任何建任务的方法。 */
export type TaskChecker = {
  repos: () => string[]
  workflow: (name: string) => string | undefined
}

/** 一次调用里的任务提议工具。返回的处理函数不抛错：参数不对、检查不通过、超过上限都作为错误结果交给 agent。 */
export const taskProposer = (o: {
  check: TaskChecker
  record: (p: Omit<TaskProposal, 'id' | 'at' | 'voided' | 'created'>, at: number) => TaskProposal
  redact: (s: string) => string
  chatId: string
  call: string
  now: () => number
}) => {
  let count = 0
  return (args: unknown): ToolOutcome => {
    const fail = (text: string): ToolOutcome => ({ text: o.redact(text), isError: true })
    const parsed = input.safeParse(args ?? {})
    if (!parsed.success) return fail(`参数不对：${parsed.error.issues.map(i => `${i.path.join('.') || '(参数)'}：${i.message}`).join('；')}`)
    const p = parsed.data
    if (count >= MAX_TASK_PROPOSALS_PER_CALL) return fail(`这一轮已经记了 ${MAX_TASK_PROPOSALS_PER_CALL} 条任务提议，不能再提：请先请用户确认已有的提议`)
    // 需求以明文交给任务里的 agent、存进任务记录：里面有已知凭据值就不收。
    if ([p.title, p.repo, p.request].some(s => o.redact(s) !== s)) return fail('任务提议里有凭据值：需求会以明文交给任务里的 agent，不能放凭据')
    const repos = o.check.repos()
    if (!repos.includes(p.repo))
      return fail(
        `仓库「${p.repo}」不是平台上的任务用过的仓库，不能提议。用过的仓库：${repos.join('、') || '（还没有）'}。用户要用别的仓库时，请提议一个用过的，并在回复里请用户在确认时改仓库`,
      )
    const problem = o.check.workflow(p.workflow)
    if (problem !== undefined) return fail(`工作流「${p.workflow}」不能用来建任务：${problem}`)
    count++
    const row = o.record({ chatId: o.chatId, call: o.call, title: p.title, input: { repo: p.repo, workflow: p.workflow, request: p.request } }, o.now())
    return { text: `任务提议 #${row.id} 已记下：「${p.title}」。任务还没有创建，要等用户确认（用户可以改仓库、工作流和需求）后才会创建：现在在命令行用 eos chat create ${row.id} 确认。`, isError: false }
  }
}
