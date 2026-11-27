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
  [
    'run',
    '--rm',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--cap-add',
    'KILL',
    '-v',
    `${join(ROOT, 'scripts', 'chat-docker-probe-inner.ts')}:/probe/inner.mts:ro`,
    '-w',
    '/app',
    image,
    'node',
    '--import',
    'tsx',
    '/probe/inner.mts',
  ],
  { encoding: 'utf8' },
)
const results = JSON.parse(out.slice(out.lastIndexOf('\n{') + 1)) as Record<string, unknown>
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
const during = results['调用期间带令牌的配置'] as Record<string, string> | string
const expect: Record<string, [unknown, unknown]> = {
  'eos-check: 不带令牌': [results['eos-check: 不带令牌'], '401'],
  'eos-check: 错的令牌': [results['eos-check: 错的令牌'], '401'],
  'eos-agent: 不带令牌': [results['eos-agent: 不带令牌'], '401'],
  'eos-agent: 错的令牌': [results['eos-agent: 错的令牌'], '401'],
  端点关闭后带对的令牌连不上: [String(results['端点关闭后 eos-agent 带对的令牌']).startsWith('ERR'), true],
  '容器里 eos chat new 有回复（dsh 以 eos-agent 读到了配置）': [results['eos chat new 的回复'], '有回复'],
  '带令牌的配置：目录 2750、文件 640，组 eos-dsh': [typeof during === 'object' ? `${during.dir} / ${during.file}` : during, '2750 eos:eos-dsh / 640 eos:eos-dsh'],
  'eos-check 读不到配置里的令牌': [typeof during === 'object' ? during['eos-check'] : during, '读不到'],
  调用结束后配置删掉了: [JSON.stringify(results['调用结束后 ephemeral 里剩下的']), '[]'],
}
const checks = Object.entries(expect).map(([name, [actual, expected]]) => ({ name, expected, actual, ok: actual === expected }))
const dir = join(ROOT, 'docs', 'e2e', 'chat-a')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'docker-probe.json'), JSON.stringify({ commit, image, results, checks }, null, 2))
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}：${c.actual}`)
console.log(JSON.stringify(results, null, 2))
process.exit(checks.every(c => c.ok) ? 0 : 1)
