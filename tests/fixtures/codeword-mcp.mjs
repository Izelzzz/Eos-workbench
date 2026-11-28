// 最小的 stdio MCP 服务（不依赖任何包），给 Claude Code 执行器的测试用：一个工具 get_codeword，返回环境变量 CODEWORD 的值。
import { createInterface } from 'node:readline'
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'eos-test', version: '0' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'get_codeword', description: '返回暗号', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: process.env.CODEWORD ?? '' }] } })
  else if (m.id !== undefined) send({ id: m.id, result: {} })
})
