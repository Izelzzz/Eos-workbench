// CI 里的确定性 E2E：起一个假模型（scripts/fake-model/），平台经 EOS_MODEL_BASE_URL 让 dsh 连它，再原样跑 scripts/e2e.ts。
// 覆盖平台、dsh、沙箱、git、检查命令和 E2E 的全部核对项（提问和回答、杀进程后续跑、评审打回再通过、npm test）；
// 不覆盖模型本身的行为（提示词、技能、模板是否让真实模型做对事），那部分仍要真实模型的 E2E（npm run e2e）。
// 用法：node --import tsx scripts/e2e-ci.ts [dsh|claude-code]（不需要模型 key 和外网；不写时是 dsh）。claude-code 时三个角色都用 Claude Code，
// 平台经 EOS_ANTHROPIC_BASE_URL 让 Claude Code 的上游连同一个假模型。E2E 的结果在 .eos/e2e/（report.json、run.log），
// 假模型收到的请求和回复在 .eos/e2e-ci/fake-model.log（e2e.ts 开头会清空 .eos/e2e，所以放在外面）
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeModel } from './fake-model/server.ts'

const ROOT = join(import.meta.dirname, '..')
// 不写参数时也认 EOS_E2E_EXECUTOR（scripts/e2e.ts 的开关），免得以为跑了 Claude Code、其实跑的是 dsh
const EXECUTOR = process.argv[2] ?? process.env.EOS_E2E_EXECUTOR ?? 'dsh'
if (EXECUTOR !== 'dsh' && EXECUTOR !== 'claude-code') throw new Error(`执行器只能是 dsh 或 claude-code（现在是 ${EXECUTOR}）`)
const OUT = join(ROOT, '.eos', 'e2e-ci')
const LOG = join(OUT, 'fake-model.log')

mkdirSync(OUT, { recursive: true })
writeFileSync(LOG, '')
const model = await startFakeModel((req, reply) => {
  const last = req.messages.at(-1)
  appendFileSync(LOG, `${JSON.stringify({ messages: req.messages.length, last: last?.content.map(b => b.type), reply })}\n`)
})

// 除了本机的假模型，出网请求一律发到一个不存在的代理而失败：DEEPSEEK_BASE_URL 万一没传到 dsh，dsh 会去连真实的模型接口，
// 在会替请求注入真实 key 的环境里（例如带凭据代理的开发机）就会悄悄花钱。e2e.ts 设了 NODE_USE_ENV_PROXY=1，Node 会走这里的代理。
const DEAD_PROXY = 'http://127.0.0.1:9'
// e2e.ts 的这些开关会换成真实的凭据或远程仓库（EOS_E2E_STORE_KEY、EOS_E2E_REPO、EOS_E2E_GIT_TOKEN 等），确定性 E2E 一律不带
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) =>
      !k.startsWith('EOS_E2E_') &&
      k !== 'EOS_MASTER_KEY' &&
      k !== 'EOS_MODEL_BASE_URL' &&
      k !== 'DEEPSEEK_BASE_URL' &&
      k !== 'EOS_ANTHROPIC_BASE_URL' &&
      k !== 'ANTHROPIC_API_KEY' &&
      k !== 'ANTHROPIC_BASE_URL',
  ),
)
const env: NodeJS.ProcessEnv = {
  ...inherited,
  EOS_MODEL_BASE_URL: model.baseUrl,
  DEEPSEEK_API_KEY: 'fake-model',
  ...(EXECUTOR === 'claude-code' ? { EOS_E2E_EXECUTOR: 'claude-code', EOS_ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: 'fake-model' } : {}),
  HTTPS_PROXY: DEAD_PROXY,
  HTTP_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  all_proxy: DEAD_PROXY,
  NO_PROXY: '127.0.0.1,localhost',
  no_proxy: '127.0.0.1,localhost',
}
const code = await new Promise<number>(resolve => {
  const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts', 'e2e.ts')], { cwd: ROOT, env, stdio: 'inherit' })
  child.on('exit', c => resolve(c ?? 1))
})
await model.close()
console.log(`\n[e2e-ci] 执行器 ${EXECUTOR}：假模型共收到 ${model.requests()} 个请求，E2E 退出码 ${code}`)
if (model.requests() === 0) {
  console.log(
    EXECUTOR === 'dsh'
      ? '[e2e-ci] 假模型一个请求也没收到：dsh 没有连到它（EOS_MODEL_BASE_URL 没有作为 DEEPSEEK_BASE_URL 传到 dsh？）'
      : '[e2e-ci] 假模型一个请求也没收到：Claude Code 的上游没有连到它（EOS_ANTHROPIC_BASE_URL 没有传到平台？）',
  )
  process.exit(1)
}
process.exit(code)
