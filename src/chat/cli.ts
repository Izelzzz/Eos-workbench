// 命令行的 eos chat：新建对话、接着说、列出历史对话、查看一个对话。src/cli.ts 只做接线。
import type { Executor } from '../executor/types.ts'
import type { TraceEvent } from '../trace/types.ts'
import { Chats, type ChatOptions } from './chat.ts'
import { diffLines, fold } from '../workflow/diff.ts'
import { saveProposal, viewProposal } from './save.ts'
import type { ChatMessage, ProposalView } from './types.ts'

export const CHAT_HELP = `  eos chat new "<话>"                                     新建一个对话（对话 agent 能读平台的工作流、约定和任务，不能改）
  eos chat send <对话> "<话>"                              在对话里接着说
  eos chat list                                           列出历史对话
  eos chat show <对话>                                    查看对话记录、用量，和 agent 的提议（与当前版本的差异）
  eos chat save <提议号> [--allow-permissions <确认码>] [--note "<备注>"]  确认保存一条提议，成为约定的新版本（涉及权限的要带 show 显示的确认码）`

const time = (at: number) => new Date(at).toISOString().replace('T', ' ').slice(0, 19)

const line = (m: ChatMessage): string => {
  if (m.role === 'user') return `\n── ${time(m.at)} 你\n${m.text}`
  if (m.role === 'error') return `\n── ${time(m.at)} 没有回复\n${m.text}`
  const reads = m.call.reads.length === 0 ? '' : `\n（用了工具：${m.call.reads.map(r => `${r.tool}${r.isError ? '✗' : ''}`).join('、')}）`
  return `\n── ${time(m.at)} 助手 · ${(m.call.ms / 1000).toFixed(1)}s · 输入 ${m.call.usage.input} 输出 ${m.call.usage.output}${reads}\n${m.text}`
}

const KIND = { workflow: '工作流', template: 'Agent 模板' } as const

/** 一条提议：状态、理由、涉及的权限、和当前版本的差异（新建的显示全文）、怎么保存。状态和权限按现在的平台状态算（和保存同一个算法）。 */
const proposalText = (v: ProposalView): string => {
  const p = v.proposal
  const head = `  #${p.id}  ${KIND[p.kind]}「${p.name}」${p.baseVersion === undefined ? '（新建）' : `（修改，基于第 ${p.baseVersion} 版）`}`
  const state = {
    saved: () => `已保存为第 ${p.saved!.version} 版（${p.saved!.actor}，${time(p.saved!.at)}）`,
    voided: () => `已作废：${p.voided!}`,
    unanswered: () => '这一轮还没有回复（还在进行，或者没做完），现在不能保存',
    stale: () => `已过期：「${p.name}」现在是第 ${v.current?.version ?? '?'} 版，保存会被拒绝，请让 agent 重新提议`,
    pending: () => '待确认，还没有保存',
  }[v.state]()
  const out = [head, `      状态：${state}`, `      理由：${p.rationale}`]
  if (v.permissions.length > 0)
    out.push(`      ⚠⚠ 涉及权限改动（按现在的平台状态算）${v.code === undefined ? '' : `，保存时必须加 --allow-permissions ${v.code}`}：`, ...v.permissions.map(x => `        ⚠ ${x}`))
  if (v.state === 'pending' || v.state === 'stale') {
    const lines = v.current === undefined ? p.content.split('\n').map(text => ({ kind: 'add' as const, text })) : fold(diffLines(v.current.content, p.content))
    out.push(v.current === undefined ? '      全文（新建）：' : `      和当前第 ${v.current.version} 版的差异（+ 新增  - 删除）：`)
    for (const l of lines) out.push(l.kind === 'skip' ? `        … 省略 ${l.count} 行` : `        ${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '} ${l.text}`)
  }
  if (v.state === 'pending') out.push(`      保存：npm run eos -- chat save ${p.id}${v.code === undefined ? '' : ` --allow-permissions ${v.code}`}`)
  return out.join('\n')
}

/** 调用进行中显示 agent 在读什么：只显示工具名，不刷屏。 */
const progress = (say: (s: string) => void) => (_id: string, e: TraceEvent) => {
  if (e.kind === 'tool_start') say(`  … 读取 ${e.name}`)
}

export const chatCommand = async (
  args: string[],
  o: Omit<ChatOptions, 'executor' | 'onEvent'> & { executor: () => Executor; say: (s: string) => void; fail: (s: string) => never; confirm?: string; note?: string },
): Promise<void> => {
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
    const proposals = o.chats.proposals(d.id)
    if (proposals.length > 0) o.say(`\n提议（agent 提的；只有用 eos chat save 确认之后才会保存）：`)
    // 经过 redact：提议记下之后平台才有的凭据值不会被打印出来（保存时也会被拒）。
    for (const p of proposals) o.say(`\n${o.redact(proposalText(viewProposal(p, o.data.store, o.conventions, o.chats)))}`)
    const m = o.chats.metrics(d.id)
    return o.say(`\n用途 ${m.purpose}：${m.calls} 次调用（${m.failed} 次没有回复），读数据 ${m.reads} 次，输入 ${m.usage.input} 输出 ${m.usage.output}，agent ${(m.agentMs / 1000).toFixed(1)}s`)
  }
  if (sub === 'save') {
    const id = /^\d{1,15}$/.test(rest[0] ?? '') ? Number(rest[0]) : o.fail(`需要提议号（数字），见 eos chat show <对话>\n${usage}`)
    const r = saveProposal({
      store: o.data.store,
      chats: o.chats,
      conventions: o.conventions,
      redact: o.redact,
      id,
      actor: 'cli',
      ...(o.confirm === undefined ? {} : { confirm: o.confirm }),
      ...(o.note === undefined ? {} : { note: o.note }),
      now: o.now,
    })
    if (!r.ok) return o.fail(r.error)
    o.say(`已保存：${KIND[r.proposal.kind]}「${r.proposal.name}」第 ${r.version} 版（来自对话 ${r.proposal.chatId} 的提议 #${r.proposal.id}${r.permissions.length > 0 ? '，确认了权限改动' : ''}）`)
    for (const x of r.permissions) o.say(`  已确认：${x}`)
    return
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
