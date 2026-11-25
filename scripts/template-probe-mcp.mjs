// scripts/template-probe.ts 用的最小 stdio MCP 服务：一个工具 probe_code，返回固定口令。
// 口令由命令行参数给出，探针据此确认返回值真的来自这个服务。
import { createInterface } from 'node:readline'

const code = process.argv[2] ?? 'MCP-OK'
const send = m => process.stdout.write(`${JSON.stringify(m)}\n`)

createInterface({ input: process.stdin }).on('line', line => {
  let m
  try {
    m = JSON.parse(line)
  } catch {
    return
  }
  if (m.id === undefined) return
  if (m.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id: m.id,
      result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'eos-template-probe', version: '1.0.0' } },
    })
  }
  if (m.method === 'tools/list') {
    return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_code', description: '返回 MCP 探针口令', inputSchema: { type: 'object', properties: {} } }] } })
  }
  if (m.method === 'tools/call') {
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: code }] } })
  }
  send({ jsonrpc: '2.0', id: m.id, result: {} })
})
