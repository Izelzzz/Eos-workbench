// 检查命令和 agent 用哪个系统用户运行（路线图第 3 项，ADR-006）。部署镜像里检查命令是 eos-check、dsh 和 agent 是 eos-agent：
// 它们和平台不是同一个用户，读不到平台进程环境（/proc/<pid>/environ）里的主密钥；检查命令也读不到 dsh 进程环境里的模型 key。
// 没有设置时它们和平台是同一个用户（本机开发时就是这样）。
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'

export const CHECK_USER_ENV = 'EOS_CHECK_USER'
/** dsh 和 agent 的用户。平台用它结束 agent 留下的进程、读 dsh 的会话日志；切换由 dsh 的入口（deploy/dsh-launch.mjs）做。 */
export const AGENT_USER_ENV = 'EOS_AGENT_USER'

/** 检查命令用的系统用户：名字、主组的 gid 和家目录（检查命令的 HOME，npm 等的缓存放在这里）。 */
export type CheckUser = { name: string; gid: number; home: string }

/** 在 /etc/passwd 的内容里找用户；没有时 undefined。 */
export const parseCheckUser = (name: string, passwd: string): CheckUser | undefined => {
  for (const line of passwd.split('\n')) {
    const f = line.split(':')
    if (f[0] === name && f.length >= 7 && /^\d+$/.test(f[3] ?? '') && f[5] !== undefined && f[5] !== '') return { name, gid: Number(f[3]), home: f[5] }
  }
  return undefined
}

/** 启动时读一次。设置了但系统里没有这个用户时抛错：不能退回到用平台的用户运行。 */
export const checkUserFrom = (env: NodeJS.ProcessEnv, passwd: () => string = () => readFileSync('/etc/passwd', 'utf8'), variable: string = CHECK_USER_ENV): CheckUser | undefined => {
  const name = env[variable]
  if (name === undefined || name === '') return undefined
  if (!/^[a-z_][a-z0-9_-]*$/.test(name)) throw new Error(`${variable}=${name} 不是合法的用户名`)
  const user = parseCheckUser(name, passwd())
  if (user === undefined) throw new Error(`${variable}=${name}，但系统里没有这个用户`)
  return user
}

/** 启动时的状态：没有设置、设置好了、设置错了（由 doctor 报出，任务不启动）。 */
export type CheckUserState = { kind: 'none' } | { kind: 'ok'; user: CheckUser } | { kind: 'invalid'; error: string }

export const resolveCheckUser = (env: NodeJS.ProcessEnv, passwd?: () => string, variable: string = CHECK_USER_ENV): CheckUserState => {
  try {
    const user = checkUserFrom(env, passwd, variable)
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
  'setpriv',
  `--reuid=${user.name}`,
  `--regid=${user.gid}`,
  '--init-groups',
  '--inh-caps=-all',
  '--ambient-caps=-all',
  '--',
  ...argv,
]

/** 本进程带着 ambient 能力（部署镜像里的平台进程，deploy/eos）。读一次就记住：能力在进程运行期间不变。 */
let ambient: boolean | undefined
const hasAmbientCaps = (): boolean => {
  if (ambient === undefined) {
    try {
      ambient = !/^CapAmb:\s*0+$/m.test(readFileSync('/proc/self/status', 'utf8'))
    } catch {
      ambient = false
    }
  }
  return ambient
}

/**
 * 平台带着 ambient 能力时（部署镜像的启动方式，deploy/eos）先清掉再运行 argv（不换用户），没有时原样返回。
 * 以 root 或带着别的有效能力启动的平台不在这里处理：部署只支持 deploy/eos 的方式。
 */
export const withoutCaps = (argv: string[]): string[] => (hasAmbientCaps() ? ['setpriv', '--inh-caps=-all', '--ambient-caps=-all', '--', ...argv] : argv)

/** 真的切换一次，确认平台进程有切换用户的能力。成功时 undefined，否则返回原因。 */
export const probeSwitch = (user: CheckUser): string | undefined => {
  const [cmd, ...args] = asUser(user, ['true'])
  const r = spawnSync(cmd!, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
  if (r.error !== undefined) return r.error.message
  return r.status === 0 ? undefined : r.stderr.trim() || `退出码 ${r.status ?? '（被信号终止）'}`
}

/** 找出工作目录在 $1 里的进程并结束，打印它们的进程号。以检查命令的用户运行：平台读不到别的用户进程的工作目录。 */
const KILL_IN_DIR = 'for p in /proc/[0-9]*; do c=$(readlink "$p/cwd" 2>/dev/null) || continue; case "$c" in "$1"|"$1"/*) kill -KILL "${p#/proc/}" 2>/dev/null && echo "${p#/proc/}";; esac; done'

/**
 * 结束 user 的、工作目录在 dir 里的进程（检查命令留下的、脱离了进程组的后台进程），返回进程号。
 * 平台撤销越界改动之前调用，和 procs.ts 的 killProcessesIn 一起：那边只结束得了平台用户自己的进程。
 * 异步：不在扫描 /proc 期间卡住 Web 服务。worktree 已经不在时什么都不做。
 */
export const killUserProcessesIn = async (user: CheckUser, dir: string, waitMs = 2000): Promise<number[]> => {
  let real: string
  try {
    real = realpathSync(dir)
  } catch {
    return []
  }
  const [cmd, ...args] = asUser(user, ['sh', '-c', KILL_IN_DIR, 'sh', real])
  const out = await new Promise<string>(done => {
    let text = ''
    const p = spawn(cmd!, args, { cwd: '/', stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => p.kill('SIGKILL'), 10_000)
    p.stdout.setEncoding('utf8').on('data', (c: string) => (text += c))
    p.on('error', () => {})
    p.on('close', () => {
      clearTimeout(timer)
      done(text)
    })
  })
  const pids = out
    .split('\n')
    .filter(l => /^\d+$/.test(l))
    .map(Number)
  // 等它们真正退出（/proc/<pid> 不分用户都看得到）：撤销越界改动时不能还有进程在写 worktree。
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && pids.some(p => existsSync(`/proc/${p}`))) await new Promise(r => setTimeout(r, 20))
  return pids
}

/**
 * 把 $1 下属于用户 $2 的文件和目录改成组 $3、组内可读写（目录还要可进入、带 setgid），不跟符号链接（find 默认 -P）。
 * 只改它自己的：别人的文件它本来也改不了。
 */
const SHARE_WITH_GROUP = [
  // 用户不在 worktree 的组里（不在部署镜像里时可能这样）就改不了组，只开放权限。
  'if id -G | tr " " "\\n" | grep -qx "$3"; then',
  '  find "$1" -user "$2" -type d \\( ! -gid "$3" -o ! -perm -2070 \\) -exec chgrp "$3" {} + -exec chmod g+rwxs {} +; d=$?;',
  '  find "$1" -user "$2" -type f \\( ! -gid "$3" -o ! -perm -060 \\) -exec chgrp "$3" {} + -exec chmod g+rw {} +; f=$?;',
  'else',
  '  find "$1" -user "$2" -type d ! -perm -070 -exec chmod g+rwx {} +; d=$?;',
  '  find "$1" -user "$2" -type f ! -perm -060 -exec chmod g+rw {} +; f=$?;',
  'fi',
  // 两条都跑完（一条失败不跳过另一条），有一条失败就报失败。
  '[ "$d" = 0 ] && [ "$f" = 0 ]',
].join('\n')

/**
 * 把 user 在 dir 里建的文件和目录交给 dir 的组（共用组 eos-work）并开放组读写。平台（在这个组里）提交、撤销越界改动时要读、删它们。
 * agent 和检查命令是别的用户，建出 0600 的文件、0755 的目录时平台读不了、删不掉；
 * 而且不是所有文件都继承 worktree 的组：dsh 写文件时先在一个 chmod 0700 的临时目录里建（chmod 清掉了 setgid），再改名过去，
 * 这样的文件属于 agent 自己的主组，只开放组权限没有用，要先改组。成功时 undefined，否则返回原因。
 */
export const shareWithGroup = async (user: CheckUser, dir: string): Promise<string | undefined> => {
  let real: string
  let gid: number
  try {
    real = realpathSync(dir)
    gid = statSync(real).gid
  } catch {
    return undefined
  }
  const [cmd, ...args] = asUser(user, ['sh', '-c', SHARE_WITH_GROUP, 'sh', real, user.name, String(gid)])
  return new Promise(done => {
    let err = ''
    const p = spawn(cmd!, args, { cwd: '/', stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000)
    p.stderr.setEncoding('utf8').on('data', (c: string) => (err = (err + c).slice(-500)))
    p.on('error', e => done(e.message))
    p.on('close', (code, signal) => {
      clearTimeout(timer)
      done(code === 0 ? undefined : err.trim() || (signal === null ? `退出码 ${code}` : `被信号 ${signal} 终止（超时）`))
    })
  })
}

/** 在 $1 下找 $2 这个会话的日志，找到就原样输出（以 dsh 的用户运行：会话目录是 0700，只有它能读）。 */
const CAT_SESSION_LOG = 'for f in "$1"/*/"$2"/"$3"; do if [ -f "$f" ]; then exec cat "$f"; fi; done; exit 3'

/**
 * 以 user 读一个 dsh 会话的日志：找到时返回原始字节，没有这个会话时 undefined，读不出来（切换失败、超时、太大）时抛错。
 * 和直接读文件（dsh.ts 的默认实现）找的是同一个位置。同步：dsh.ts 读日志的地方本来就是同步的。
 */
export const readSessionLogAs =
  (user: CheckUser, file: string) =>
  (sessionsRoot: string, sessionId: string): Buffer | undefined => {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined
    const [cmd, ...args] = asUser(user, ['sh', '-c', CAT_SESSION_LOG, 'sh', sessionsRoot, sessionId, file])
    const r = spawnSync(cmd!, args, { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 1024, timeout: 30_000 })
    if (r.status === 0) return r.stdout
    if (r.status === 3) return undefined
    throw new Error(`以 ${user.name} 读会话日志 ${sessionId} 失败：${r.error?.message ?? (r.stderr?.toString().trim() || `退出码 ${r.status ?? '（被信号终止）'}`)}`)
  }
