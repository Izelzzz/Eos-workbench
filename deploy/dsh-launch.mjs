// 容器里启动 dsh 的包装（Dockerfile 的 EOS_DSH_LAUNCHER 指向它，平台把它当作 dsh 的入口）。
// 平台进程带着 SETUID、SETGID、KILL（deploy/eos），dsh、agent 和 dsh 在沙箱外启动的 MCP 服务都不能带着：
// 用 setpriv 清掉全部能力，切换到 EOS_AGENT_USER（镜像里是 eos-agent），再运行真正的 dsh。
// eos-agent 读不到平台进程（eos）环境里的主密钥。process.execve 把这个进程整个换掉（进程号不变、不多一层进程），
// 平台发的信号、看到的退出码和进程退出的时刻都直接是 dsh 的。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(join(import.meta.dirname, '..', 'package.json'))
const pkg = require.resolve('@deepseek-ai/dsh/package.json')
const bin = join(dirname(pkg), JSON.parse(readFileSync(pkg, 'utf8')).bin.dsh)

const agent = process.env.EOS_AGENT_USER ?? ''
const env = { ...process.env }
const switchUser = []
if (agent !== '') {
  // 名字按 /etc/passwd 找家目录：dsh 的 native 模块缓存放在 eos-agent 自己的家目录，agent 在沙箱里写不了它，
  // 平台（eos）也不加载它（平台有自己的一份，在 eos 的家目录）。
  const entry = readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .map(l => l.split(':'))
    .find(f => f[0] === agent)
  if (entry === undefined) {
    process.stderr.write(`dsh-launch：EOS_AGENT_USER=${agent}，但系统里没有这个用户\n`)
    process.exit(125)
  }
  const home = entry[5]
  Object.assign(env, { HOME: home, USER: agent, LOGNAME: agent, NARB_NATIVE_CACHE_DIR: join(home, '.cache', 'native-addons') })
  // worktree 属于平台用户，agent 在里面跑 git 时 git 默认拒绝（dubious ownership）。
  Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' })
  switchUser.push(`--reuid=${agent}`, `--regid=${entry[3]}`, '--init-groups')
}
process.execve('/usr/bin/setpriv', ['setpriv', ...switchUser, '--inh-caps=-all', '--ambient-caps=-all', '--', process.execPath, bin, ...process.argv.slice(2)], env)
