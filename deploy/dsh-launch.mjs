// 容器里启动 dsh 的包装（Dockerfile 的 EOS_DSH_LAUNCHER 指向它，平台把它当作 dsh 的入口）。
// 平台进程带着切换用户用的 SETUID、SETGID（deploy/eos），dsh、agent 和 dsh 在沙箱外启动的 MCP 服务都不能带着：
// 用 setpriv 清掉全部能力再运行真正的 dsh。process.execve 把这个进程整个换掉（进程号不变、不多一层进程），
// 平台发的信号、看到的退出码和进程退出的时刻都直接是 dsh 的。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(join(import.meta.dirname, '..', 'package.json'))
const pkg = require.resolve('@deepseek-ai/dsh/package.json')
const bin = join(dirname(pkg), JSON.parse(readFileSync(pkg, 'utf8')).bin.dsh)
process.execve('/usr/bin/setpriv', ['setpriv', '--inh-caps=-all', '--ambient-caps=-all', '--', process.execPath, bin, ...process.argv.slice(2)], process.env)
