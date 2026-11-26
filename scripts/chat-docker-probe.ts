// 对话 agent 的 MCP 端点在部署镜像里的防护实测（对话 agent PR A）。不调模型。
// 用法：docker build -t eos-workbench:chat-probe . && node --import tsx scripts/chat-docker-probe.ts
// 在容器里以 root 跑 scripts/chat-docker-probe-inner.ts（镜像里的 /app 就是构建时的代码），结果写到 docs/e2e/chat-a/docker-probe.json。
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const image = process.env.EOS_PROBE_IMAGE ?? 'eos-workbench:chat-probe'
const out = execFileSync(
  'docker',
  ['run', '--rm', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'KILL', '-v', `${join(ROOT, 'scripts', 'chat-docker-probe-inner.ts')}:/probe/inner.ts:ro`, '-w', '/app', image, 'node', '--import', 'tsx', '/probe/inner.ts'],
  { encoding: 'utf8' },
)
const results = JSON.parse(out.slice(out.indexOf('{'))) as Record<string, string>
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const expect: Record<string, string> = {
  'eos-check: 不带令牌': '401',
  'eos-check: 错的令牌': '401',
  'eos-agent: 不带令牌': '401',
  'eos-agent: 错的令牌': '401',
  'eos-check: 读 dsh 配置里的令牌': '读不到',
}
const checks = Object.entries(expect).map(([k, v]) => ({ name: k, expected: v, actual: results[k], ok: results[k] === v }))
const dir = join(ROOT, 'docs', 'e2e', 'chat-a')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'docker-probe.json'), JSON.stringify({ commit, image, results, checks }, null, 2))
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}：${c.actual}`)
console.log(JSON.stringify(results, null, 2))
process.exit(checks.every(c => c.ok) ? 0 : 1)
