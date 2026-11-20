// PoC 1: drive dsh over SDK, get final text + notifications + token usage.
import { make } from './common.ts'
await using h = make()
const t0 = Date.now()
const r = await h.run('用一句话回答：1+1 等于几？')
const msgs = r.events.filter((e: any) => e.type === 'assistant/message')
console.log(JSON.stringify({ ms: Date.now() - t0, sessionId: r.sessionId, finishReason: r.finishReason, final: r.finalResponse,
  model: [...new Set(msgs.map((e: any) => e.data.message?.source?.model))],
  eventTypes: [...new Set(r.events.map((e: any) => e.type))], notifs: [...new Set(r.notifications.map((n: any) => n.method))] }, null, 1))
console.log('usage', JSON.stringify(msgs.map((e: any) => e.data?.usage ?? e.data?.message?.usage)))
