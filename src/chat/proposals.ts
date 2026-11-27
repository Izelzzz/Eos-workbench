// 对话 agent 的提议：agent 能提议新建或修改一个工作流或 Agent 模板，平台检查后记成「待确认」的提议。
// 提议不改任何约定：这里只写 chat_proposals 表。保存成约定的新版本只能由人确认（命令行或网页），不经过 agent 的任何工具。
// 检查和保存约定时一样（Conventions.validate：格式、名字、引用的模板、技能和文档）；不通过就把错误退给 agent，让它改了再提。
import { z } from 'zod'
import type { Conventions } from '../conventions/conventions.ts'
import type { Store } from '../store/store.ts'
import type { ChatStore } from './store.ts'
import type { ToolOutcome } from './tools.ts'
import type { ProposalKind } from './types.ts'

export const PROPOSE_TOOL = 'propose_convention'
/** 一次调用（用户说一句话）里最多记几条提议：防止 agent 在一轮里刷出一堆。 */
export const MAX_PROPOSALS_PER_CALL = 5
export const MAX_CONTENT_CHARS = 60_000

const KIND_NAMES: Record<ProposalKind, string> = { workflow: '工作流', template: 'Agent 模板' }

const input = z.object({
  kind: z.enum(['workflow', 'template']),
  name: z.string().min(1).max(64),
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  rationale: z.string().min(1).max(4000),
})

export const proposeToolSpec = () => ({
  name: PROPOSE_TOOL,
  description:
    '提议新建或修改一个工作流（kind: workflow）或 Agent 模板（kind: template）。content 是完整的 YAML（不是片段），name 必须和 YAML 里的 name 一致；rationale 写为什么这样改。' +
    '平台会按保存约定时的规则检查，不通过会返回错误，改了再提。通过的提议只是记下来，不会生效：要等用户确认后才保存成新版本。' +
    '工作流引用的 Agent 模板必须已经在平台上（新模板要先由用户确认保存）。',
  inputSchema: z.toJSONSchema(input),
})

/**
 * 一次调用里的提议工具。chatId、call 是这次调用的对话和调用 id（记进提议，网页和命令行按它找到提议来自哪句话）。
 * 返回的处理函数不抛错：参数不对、检查不通过、超过上限都作为错误结果交给 agent。
 */
export const proposer = (o: { chats: ChatStore; store: Store; conventions: Conventions; redact: (s: string) => string; chatId: string; call: string; now: () => number }) => {
  let count = 0
  return (args: unknown): ToolOutcome => {
    const fail = (text: string): ToolOutcome => ({ text: o.redact(text), isError: true })
    const parsed = input.safeParse(args ?? {})
    if (!parsed.success) return fail(`参数不对：${parsed.error.issues.map(i => `${i.path.join('.') || '(参数)'}：${i.message}`).join('；')}`)
    const p = parsed.data
    if (count >= MAX_PROPOSALS_PER_CALL) return fail(`这一轮已经记了 ${MAX_PROPOSALS_PER_CALL} 条提议，不能再提：请先请用户确认已有的提议`)
    // 约定以明文保存、人人可见：内容里有已知凭据值就不收。
    if (o.redact(p.content) !== p.content || o.redact(p.rationale) !== p.rationale) return fail('提议里有凭据值：约定以明文保存，不能放凭据')
    const errors = o.conventions.validate(p.kind, p.name, p.content)
    if (errors.length > 0) return fail(`${KIND_NAMES[p.kind]}「${p.name}」没有通过检查，改了再提：\n${errors.map(e => `- ${e.path}：${e.message}`).join('\n')}`)
    const current = o.store.convention(p.kind, p.name)
    if (current?.content === p.content) return fail(`和${KIND_NAMES[p.kind]}「${p.name}」当前的第 ${current.version} 版完全一样，不需要提议`)
    count++
    const row = o.chats.addProposal({ chatId: o.chatId, call: o.call, kind: p.kind, name: p.name, ...(current === undefined ? {} : { baseVersion: current.version }), content: p.content, rationale: p.rationale }, o.now())
    return {
      text: `提议 #${row.id} 已记下：${current === undefined ? '新建' : `修改（基于第 ${current.version} 版）`}${KIND_NAMES[p.kind]}「${p.name}」。它还没有生效，要等用户确认后才会保存。`,
      isError: false,
    }
  }
}
