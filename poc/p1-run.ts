// PoC 1: drive dsh over SDK, get final text + notifications + token usage.
import { DeepSeekHarness } from './sdk-client/index.ts'
const home = process.env.POC + '/home', ws = process.env.POC + '/ws'
await using h = new DeepSeekHarness({ profile: 'sdk', dshHome: home, cwd: ws, dshBin: process.env.DSH_BIN,
  provider: 'deepseek-official', model: 'deepseek-v4-flash' } as any)
const t0 = Date.now()
const r = await h.run('用一句话回答：1+1 等于几？')
console.log(JSON.stringify({ ms: Date.now() - t0, sessionId: r.sessionId, finishReason: r.finishReason, final: r.finalResponse,
  eventTypes: [...new Set(r.events.map((e: any) => e.type))], notifs: [...new Set(r.notifications.map((n: any) => n.method))] }, null, 1))
const usage = r.events.filter((e: any) => /assistant\/message|usage/.test(e.type)).map((e: any) => e.usage ?? e.data?.usage ?? e.payload?.usage)
console.log('usage', JSON.stringify(usage))
