// 检查命令用哪个系统用户运行（路线图第 3 项，ADR-006）。部署镜像里是 eos-check：
// 它和平台、dsh 不是同一个用户，读不到它们进程环境（/proc/<pid>/environ）里的主密钥和模型 key。
// 没有设置时检查命令和平台是同一个用户（本机开发时就是这样）。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const CHECK_USER_ENV = 'EOS_CHECK_USER'

/** 检查命令用的系统用户：名字和家目录（检查命令的 HOME，npm 等的缓存放在这里）。 */
export type CheckUser = { name: string; home: string }

/** 在 /etc/passwd 的内容里找用户；没有时 undefined。 */
export const parseCheckUser = (name: string, passwd: string): CheckUser | undefined => {
  for (const line of passwd.split('\n')) {
    const f = line.split(':')
    if (f[0] === name && f.length >= 7 && f[5] !== undefined && f[5] !== '') return { name, home: f[5] }
  }
  return undefined
}

/** 启动时读一次。设置了但系统里没有这个用户时抛错：不能退回到用平台的用户运行检查命令。 */
export const checkUserFrom = (env: NodeJS.ProcessEnv, passwd: () => string = () => readFileSync('/etc/passwd', 'utf8')): CheckUser | undefined => {
  const name = env[CHECK_USER_ENV]
  if (name === undefined || name === '') return undefined
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) throw new Error(`${CHECK_USER_ENV}=${name} 不是合法的用户名`)
  const user = parseCheckUser(name, passwd())
  if (user === undefined) throw new Error(`${CHECK_USER_ENV}=${name}，但系统里没有这个用户`)
  return user
}

/** 启动时的状态：没有设置、设置好了、设置错了（由 doctor 报出，任务不启动）。 */
export type CheckUserState = { kind: 'none' } | { kind: 'ok'; user: CheckUser } | { kind: 'invalid'; error: string }

export const resolveCheckUser = (env: NodeJS.ProcessEnv, passwd?: () => string): CheckUserState => {
  try {
    const user = checkUserFrom(env, passwd)
    return user === undefined ? { kind: 'none' } : { kind: 'ok', user }
  } catch (e) {
    return { kind: 'invalid', error: (e as Error).message }
  }
}

/**
 * 以 user 运行 argv 的命令行。setpriv 切换用户和组（含补充组，worktree 靠共用组可写），并清掉全部能力：
 * 平台进程带着切换用户用的 SETUID、SETGID，检查命令不能带着它们（否则能切回平台的用户）。
 */
export const asUser = (user: CheckUser, argv: string[]): string[] => [
  'setpriv', `--reuid=${user.name}`, `--regid=${user.name}`, '--init-groups', '--inh-caps=-all', '--ambient-caps=-all', '--', ...argv,
]

/** 真的切换一次，确认平台进程有切换用户的能力。成功时 undefined，否则返回原因。 */
export const probeSwitch = (user: CheckUser): string | undefined => {
  const [cmd, ...args] = asUser(user, ['true'])
  const r = spawnSync(cmd!, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  if (r.error !== undefined) return r.error.message
  return r.status === 0 ? undefined : (r.stderr.trim() || `退出码 ${r.status ?? '（被信号终止）'}`)
}
