// 5. 事件流和用量。打开部分消息（流式增量），一轮里有思考、文本和一次工具调用；统计收到的消息类型和内容块类型，
//    打印 result 里的用量（缓存读写分开）、按模型的用量和成本。
import { baseOptions, check, dirs, done, note, run } from './common.ts'
import { script } from './upstream.ts'

const d = dirs('c5')
const tag = script('c5', [() => [{ thinking: '先跑 echo。' }, { tool: 'Bash', input: { command: 'echo hi' } }], () => [{ thinking: '输出是 hi。' }, { text: '输出是 hi' }]])
const seen: Record<string, number> = {}
const bump = (k: string) => { seen[k] = (seen[k] ?? 0) + 1 }
const t = await run(tag + '先想一想，然后用 Bash 执行 echo hi，最后用一句话告诉我输出是什么。', {
  ...baseOptions(d.home, d.ws), tools: ['Bash'], includePartialMessages: true, effort: 'high', thinking: { type: 'adaptive' },
  canUseTool: async (_n, i) => ({ behavior: 'allow', updatedInput: i }),
}, m => {
  const sub = (m as any).subtype ?? (m as any).event?.type ?? ''
  bump(`${m.type}${sub ? '/' + sub : ''}`)
  if (m.type === 'assistant') for (const c of (m as any).message.content) bump(`assistant.content/${c.type}`)
  if (m.type === 'user' && Array.isArray((m as any).message.content)) for (const c of (m as any).message.content) bump(`user.content/${c.type}`)
  if (m.type === 'stream_event' && (m as any).event?.type === 'content_block_delta') bump(`delta/${(m as any).event.delta.type}`)
})
note('收到的消息类型和次数', seen)
const r: any = t.result
note('result.usage', r?.usage)
note('result.modelUsage', r?.modelUsage)
note('result 其他字段', { total_cost_usd: r?.total_cost_usd, duration_ms: r?.duration_ms, duration_api_ms: r?.duration_api_ms, num_turns: r?.num_turns, stop_reason: r?.stop_reason })
note('每条 assistant 消息的 usage', t.messages.filter(m => m.type === 'assistant').map((m: any) => ({ id: m.message.id, usage: m.message.usage })))
check('事件里有文本、工具调用、工具结果', ['assistant.content/text', 'assistant.content/tool_use', 'user.content/tool_result'].every(k => seen[k]), seen)
check('事件里有思考（内容块或增量）', !!(seen['assistant.content/thinking'] || seen['delta/thinking_delta']), seen)
check('有流式增量（stream_event）', !!seen['stream_event/content_block_delta'], seen)
check('用量里缓存读、缓存写分开', typeof r?.usage?.cache_read_input_tokens === 'number' && typeof r?.usage?.cache_creation_input_tokens === 'number', r?.usage)
check('有成本数字', typeof r?.total_cost_usd === 'number', r?.total_cost_usd)
done()
