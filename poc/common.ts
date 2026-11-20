import { DeepSeekHarness } from './sdk-client/index.ts'
export const home = process.env.POC + '/home', ws = process.env.POC + '/ws'
export const make = (extra: Record<string, unknown> = {}) => new DeepSeekHarness({ profile: 'sdk', dshHome: home, cwd: ws,
  dshBin: process.env.DSH_BIN, provider: "deepseek-official", initializeTimeoutMs: 60000, model: 'deepseek-v4-flash', ...extra } as any)
export const tools = (r: any) => r.events.filter((e: any) => e.type === 'assistant/message')
  .flatMap((e: any) => (e.content ?? e.message?.content ?? []).filter((c: any) => c.type === 'tool-call' || c.type === 'tool_use').map((c: any) => c.name ?? c.toolName))
export const usage = (r: any) => r.events.filter((e: any) => e.type === 'assistant/message').reduce((a: number, e: any) => a + (e.usage?.totalTokens ?? 0), 0)
