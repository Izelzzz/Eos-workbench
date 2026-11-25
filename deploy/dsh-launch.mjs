// 容器里启动 dsh 的包装（Dockerfile 的 EOS_DSH_LAUNCHER 指向它，平台把它当作 dsh 的入口）。
// 平台进程带着切换用户用的 SETUID、SETGID（deploy/eos），dsh、agent 和 dsh 在沙箱外启动的 MCP 服务都不能带着：
// 这里用 setpriv 清掉全部能力再启动真正的 dsh。--pdeathsig：这个包装被杀时 dsh 也结束，不会留下没人管的 dsh。
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(join(import.meta.dirname, '..', 'package.json'))
const pkg = require.resolve('@deepseek-ai/dsh/package.json')
const bin = JSON.parse(readFileSync(pkg, 'utf8')).bin.dsh
const child = spawn('setpriv', ['--inh-caps=-all', '--ambient-caps=-all', '--pdeathsig=KILL', '--', process.execPath, join(dirname(pkg), bin), ...process.argv.slice(2)], { stdio: 'inherit' })

for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s))
child.on('error', e => {
  process.stderr.write(`dsh-launch：启动不了 dsh：${e.message}\n`)
  process.exit(125)
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
