// PoC 5: rebuild per-step timing, tokens and tool trace from the on-disk append-only session log (zstd jsonl).
import { readFileSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const root = process.env.POC + '/home/sessions'
const dir = readdirSync(root)[0], sid = process.argv[2]
const lines = zstdDecompressSync(readFileSync(`${root}/${dir}/${sid}/session.v4.jsonl.zstd`)).toString().trim().split('\n').map(l => JSON.parse(l))
const seqs = lines.map(l => l.seq).filter((s: any) => typeof s === 'number')
const steps: Record<string, any> = {}
for (const e of lines) {
  const k = `${e.data?.turn}.${e.data?.step}`
  if (e.type === 'step/start') steps[k] = { start: e.time, tools: [], tokens: 0 }
  if (e.type === 'step/end' && steps[k]) steps[k].ms = e.time - steps[k].start
  if (e.type === 'tool/call' && steps[k]) steps[k].tools.push(e.data.name)
  if (e.type === 'assistant/message' && steps[k]) { steps[k].tokens = e.data?.usage?.totalTokens ?? e.data?.message?.usage?.totalTokens; steps[k].model = e.data?.source?.model }
}
console.log(JSON.stringify({ lines: lines.length, appendOnlyMonotonicSeq: seqs.every((s: number, i: number) => i === 0 || s > seqs[i - 1]),
  steps: Object.fromEntries(Object.entries(steps).map(([k, v]: any) => [k, { ms: v.ms, tokens: v.tokens, model: v.model, tools: v.tools }])) }, null, 1))
