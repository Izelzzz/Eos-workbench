// 检查命令用独立用户运行（路线图第 3 项 ③b）的容器探针。不调用模型。
// 1. 用旧镜像（检查命令还和平台同一个用户）在数据卷里留下一个 worktree，再换成新镜像启动，核对升级后它归共用组、检查命令能写；
// 2. 容器里跑 eos doctor；
// 3. 以平台的身份（eos，带 SETUID、SETGID）用真正的 runChecks 跑扫描，对照以平台用户直接跑的同一个扫描（check-user-probe-inner.ts）。
// 结果写到 .eos/check-user-probe/report.json。
// 用法：node --import tsx scripts/check-user-probe.ts
// 环境变量：EOS_PROBE_OLD_IMAGE 旧镜像（默认 eos-workbench:local）；EOS_PROBE_COMPOSE_FILES 用冒号分隔的额外 compose 文件。
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'check-user-probe')
const PROJECT = 'eos-check-user-probe'
const NEW = 'eos-workbench:check-user-probe'
const OLD = process.env.EOS_PROBE_OLD_IMAGE ?? 'eos-workbench:local'
const files = ['compose.yaml', ...(process.env.EOS_PROBE_COMPOSE_FILES ?? '').split(':').filter(Boolean)].flatMap(f => ['-f', f])
// 主密钥和模型 key 都是这次生成的假值：只看检查命令能不能读到，不调用模型。
const env = { ...process.env, EOS_MASTER_KEY: randomBytes(32).toString('base64'), DEEPSEEK_API_KEY: 'sk-probe-not-a-real-key' }
mkdirSync(OUT, { recursive: true })

const compose = (image: string, ...a: string[]): string =>
  execFileSync('docker', ['compose', '-p', PROJECT, ...files, ...a], { cwd: ROOT, encoding: 'utf8', env: { ...env, EOS_IMAGE: image }, stdio: ['ignore', 'pipe', 'pipe'] })
const exec = (image: string, args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: compose(image, 'exec', '-T', ...args) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}
const waitUp = (image: string) => {
  for (let i = 0; i < 60; i++) {
    if (exec(image, ['eos', 'node', '-e', "fetch('http://127.0.0.1:4317/api/tasks').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]).code === 0) return
    execFileSync('sleep', ['2'])
  }
  throw new Error(`${image} 没有起来：\n${compose(image, 'logs', '--no-color', 'eos')}`)
}

compose(NEW, 'build')
compose(NEW, 'down', '-v')
try {
  // 1. 旧镜像：以平台用户（旧镜像的默认用户 eos）在 worktrees 下留一个文件。
  compose(OLD, 'up', '-d')
  waitUp(OLD)
  const oldUser = exec(OLD, ['eos', 'sh', '-c', 'id -un && mkdir -p /data/worktrees/old-task && echo old > /data/worktrees/old-task/old.txt && stat -c "%U:%G %a" /data/worktrees/old-task/old.txt'])
  compose(OLD, 'down')

  // 2. 新镜像，同一个数据卷。
  compose(NEW, 'up', '-d')
  waitUp(NEW)
  const doctor = exec(NEW, ['eos', 'eos', 'doctor'])
  const processes = exec(NEW, ['eos', 'ps', '-eo', 'pid,user,group,comm'])
  const upgraded = exec(NEW, ['eos', 'sh', '-c', 'stat -c "%U:%G %a" /data/worktrees /data/worktrees/old-task /data/worktrees/old-task/old.txt'])
  const oldWritable = exec(NEW, ['-u', 'eos-check', 'eos', 'sh', '-c', 'echo by-check >> /data/worktrees/old-task/old.txt && echo ok'])
  // 3. 和 deploy/eos 启动平台时同样的降权方式。
  const inner = exec(NEW, [
    '-e',
    'HOME=/home/eos',
    'eos',
    'setpriv',
    '--reuid=eos',
    '--regid=eos',
    '--init-groups',
    '--inh-caps=+setuid,+setgid',
    '--ambient-caps=+setuid,+setgid',
    '--',
    'sh',
    '-c',
    'umask 002 && cd /app && node --import tsx scripts/check-user-probe-inner.ts',
  ])
  const platformEnv = exec(NEW, [
    '-u',
    'eos',
    'eos',
    'sh',
    '-c',
    'p=$(pgrep -u eos -o -f "src/cli.ts web"); tr "\\0" "\\n" < /proc/$p/environ | grep -E "^(HOME|USER)="; grep -E "^(Cap(Inh|Prm|Eff|Amb)|NoNewPrivs):" /proc/$p/status; echo umask=$(grep -E "^Umask" /proc/$p/status)',
  ])
  const report = {
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    uncommitted: execFileSync('git', ['status', '--porcelain', '--', 'Dockerfile', 'compose.yaml', 'deploy', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    oldImage: OLD,
    oldUser: oldUser.out.trim().split('\n'),
    upgraded: upgraded.out.trim().split('\n'),
    oldWorktreeWritableByCheckUser: oldWritable.out.trim(),
    doctor: { code: doctor.code, out: doctor.out.trim().split('\n') },
    processes: processes.out.trim().split('\n'),
    platformProcess: platformEnv.out.trim().split('\n'),
    probe: inner.code === 0 ? JSON.parse(inner.out.trim().split('\n').at(-1)!) : { code: inner.code, out: inner.out },
  }
  writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} finally {
  try {
    compose(NEW, 'down', '-v')
  } catch (e) {
    process.stderr.write(`清理失败：${(e as Error).message}\n`)
  }
}
