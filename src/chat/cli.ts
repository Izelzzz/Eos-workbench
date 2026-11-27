// 命令行的 eos chat：新建对话、接着说、列出历史对话、查看一个对话。src/cli.ts 只做接线。
import type { Executor } from '../executor/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import { Chats, type ChatOptions } from './chat.ts'
import type { ChatMessage } from './types.ts'

export const CHAT_HELP = `  eos chat new "<话>"                                     新建一个对话（对话 agent 能读平台的工作流、约定和任务，不能改）
  eos chat send <对话> "<话>"                              在对话里接着说
  eos chat list                                           列出历史对话
  eos chat show <对话>                                    查看对话记录和用量`

const time = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 19)

const line = (m: ChatMessage): string => {
  if (m.role === 'user') return `\n── ${time(m.at)} 你\n${m.text}`
  if (m.role === 'error') return `\n── ${time(m.at)} 没有回复\n${m.text}`
  const reads = m.call.reads.length === 0 ? '' : `\n（读了：${m.call.reads.map(r => `${r.tool}${r.isError ? '✗' : ''}`).join('、')}）`
  return `\n── ${time(m.at)} 助手 · ${(m.call.ms / 1000).toFixed(1)}s · 输入 ${m.call.usage.input} 输出 ${m.call.usage.output}${reads}\n${m.text}`
}

/** 调用进行中显示 agent 在读什么：只显示工具名，不刷屏。 */
const progress = (say: (s: string) => void) => (_id: string, e: TraceEvent) => {
  if (e.kind === 'tool_start') say(`  … 读取 ${e.name}`)
}

export const chatCommand = async (args: string[], o: Omit<ChatOptions, 'executor' | 'onEvent'> & { executor: () => Executor; say: (s: string) => void; fail: (s: string) => never }): Promise<void> => {
  const [sub, ...rest] = args
  const usage = `用法：\n${CHAT_HELP}`
  if (sub === 'list') {
    const all = o.chats.list()
    if (all.length === 0) return o.say('还没有对话')
    for (const c of all) o.say(`${c.id}  ${time(c.updatedAt)}  ${String(c.messages).padStart(3)} 条  ${c.title}`)
    return
  }
  if (sub === 'show') {
    const d = o.chats.detail(rest[0] ?? '') ?? o.fail(`没有对话 ${rest[0] ?? ''}`)
    o.say(`对话 ${d.id}：${d.title}`)
    for (const m of d.log) o.say(line(m))
    const m = o.chats.metrics(d.id)
    return o.say(`\n用途 ${m.purpose}：${m.calls} 次调用（${m.failed} 次没有回复），读数据 ${m.reads} 次，输入 ${m.usage.input} 输出 ${m.usage.output}，agent ${(m.agentMs / 1000).toFixed(1)}s`)
  }
  if (sub !== 'new' && sub !== 'send') return o.fail(usage)
  const id = sub === 'send' ? (rest[0] ?? o.fail(usage)) : undefined
  const text = (sub === 'send' ? rest.slice(1) : rest).join(' ')
  const ex = o.executor()
  let r
  try {
    const chats = new Chats({ ...o, executor: ex, onEvent: progress(o.say) })
    r = id === undefined ? await chats.start(text, 'cli') : await chats.send(id, text, 'cli')
  } finally {
    await ex.close()
  }
  if (!r.ok) return o.fail(r.chat === undefined ? r.error : `${r.error}\n对话：${r.chat.id}`)
  o.say(line(o.chats.log(r.chat.id).at(-1)!))
  o.say(`\n接着说：npm run eos -- chat send ${r.chat.id} "<话>"`)
}
