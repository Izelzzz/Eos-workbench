// dsh 和 agent 用独立用户运行（路线图第 3 项 ③c）的容器探针。不调用模型。
// 1. 旧镜像（dsh 以 eos 运行）打开一个 dsh 会话，留下升级前的 dsh 数据目录；
// 2. 换成新镜像启动（deploy/eos 迁移 dsh 的数据目录），跑 eos doctor，记下迁移后的目录；
// 3. 以平台的身份跑 agent-user-probe-inner.ts：dsh 的用户、平台读会话日志、换 key 重启、扫描、残留进程、续接升级前的会话。
// 结果写到 .eos/agent-user-probe/report.json。
// 用法：node --import tsx scripts/agent-user-probe.ts
// 环境变量：EOS_PROBE_OLD_IMAGE 旧镜像（默认 eos-workbench:local）；EOS_PROBE_COMPOSE_FILES 用冒号分隔的额外 compose 文件。
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'agent-user-probe')
const PROJECT = 'eos-agent-user-probe'
const NEW = 'eos-workbench:agent-user-probe'
const OLD = process.env.EOS_PROBE_OLD_IMAGE ?? 'eos-workbench:local'
const UPGRADE_KEY = 'upgrade-probe/build'
const files = ['compose.yaml', ...(process.env.EOS_PROBE_COMPOSE_FILES ?? '').split(':').filter(Boolean)].flatMap(f => ['-f', f])
// 主密钥和模型 key 都是假值：只看谁能读到，不调用模型。
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
    const up = exec(image, ['-u', 'eos', 'eos', 'node', '-e', "fetch('http://127.0.0.1:4317/api/tasks').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"])
    if (up.code === 0) return
    execFileSync('sleep', ['2'])
  }
  throw new Error(`${image} 没有起来：\n${compose(image, 'logs', '--no-color', 'eos')}`)
}
const lines = (s: string) => s.trim().split('\n')

compose(NEW, 'build')
compose(NEW, 'down', '-v')
try {
  // 1. 旧镜像。
  compose(OLD, 'up', '-d')
  waitUp(OLD)
  compose(OLD, 'cp', join(ROOT, 'scripts', 'agent-user-probe-old.ts'), 'eos:/app/scripts/agent-user-probe-old.ts')
  const old = exec(OLD, [
    '-u',
    'eos',
    'eos',
    'sh',
    '-c',
    'cd /app && node --import tsx scripts/agent-user-probe-old.ts "$1" && find /data/dsh -maxdepth 3 -printf "%M %u:%g %p\\n" | sort',
    'sh',
    UPGRADE_KEY,
  ])
  compose(OLD, 'down')

  // 2. 新镜像，同一个数据卷。
  compose(NEW, 'up', '-d')
  waitUp(NEW)
  const logs = compose(NEW, 'logs', '--no-color', 'eos')
  const doctor = exec(NEW, ['eos', 'eos', 'doctor'])
  const layout = exec(NEW, ['-u', 'eos', 'eos', 'sh', '-c', 'ls -la /data; find /data/dsh -maxdepth 3 -printf "%M %u:%g %p\\n" | sort | head -40'])
  // 3. 和 deploy/eos 启动平台时同样的降权方式。
  const inner = exec(NEW, [
    '-e',
    'HOME=/home/eos',
    'eos',
    'setpriv',
    '--reuid=eos',
    '--regid=eos',
    '--init-groups',
    '--inh-caps=+setuid,+setgid,+kill',
    '--ambient-caps=+setuid,+setgid,+kill',
    '--',
    'sh',
    '-c',
    'umask 002 && cd /app && node --import tsx scripts/agent-user-probe-inner.ts "$1"',
    'sh',
    UPGRADE_KEY,
  ])
  const report = {
    commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    uncommitted: execFileSync('git', ['status', '--porcelain', '--', 'Dockerfile', 'compose.yaml', 'deploy', 'src', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    oldImage: OLD,
    beforeUpgrade: { code: old.code, out: lines(old.out) },
    migrationLog: lines(logs).filter(l => l.includes('eos：')),
    afterUpgrade: lines(layout.out),
    doctor: { code: doctor.code, out: lines(doctor.out) },
    probe: inner.code === 0 ? JSON.parse(lines(inner.out).at(-1)!) : { code: inner.code, out: inner.out },
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
