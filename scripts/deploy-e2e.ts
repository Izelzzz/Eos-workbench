// Docker Compose 部署的端到端验证：用真实模型在容器里跑完一个 standard 任务，再重建容器核对数据还在。
// 全程只经过部署出来的接口：docker compose（构建、启动、exec）和 Web 服务的 HTTP 接口，不读写宿主机上的数据目录。
// 1. docker compose 构建并启动；容器里跑 eos doctor；
// 2. 在容器的 /data/repos 里建一个示例仓库，通过 POST /api/tasks 发起任务，agent 提问时用接口回答；
// 3. 任务结束后，在容器里核对 worktree 的 npm test 和提交；
// 4. docker compose down（删掉容器，保留数据卷）再 up，核对任务和 worktree 都还在。
// 结果写到 .eos/deploy-e2e/report.json，过程写到 run.log。
// 用法：DEEPSEEK_API_KEY=<key> node --import tsx scripts/deploy-e2e.ts
// 环境变量：EOS_E2E_COMPOSE_FILES 用冒号分隔的额外 compose 文件（例如构建机需要的网络设置）；EOS_E2E_URL 默认 http://127.0.0.1:4317。
// 会占用宿主机的 4317 端口，不要在已经跑着 Eos 的服务器上运行。compose 项目名是 eos-deploy-e2e、镜像标签是 eos-workbench:e2e，结束时连数据卷一起删掉。
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.eos', 'deploy-e2e')
const LOG = join(OUT, 'run.log')
const BASE = process.env.EOS_E2E_URL ?? 'http://127.0.0.1:4317'
const PROJECT = 'eos-deploy-e2e'
const files = ['compose.yaml', ...(process.env.EOS_E2E_COMPOSE_FILES ?? '').split(':').filter(Boolean)].flatMap(f => ['-f', f])
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const log = (line: string) => {
  appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
  process.stdout.write(`${line}\n`)
}
const compose = (...a: string[]) => {
  log(`$ docker compose ${a.join(' ')}`)
  // 用自己的镜像标签，不覆盖服务器上正在用的 eos-workbench:local。
  const out = execFileSync('docker', ['compose', '-p', PROJECT, ...files, ...a], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EOS_IMAGE: 'eos-workbench:e2e' } })
  if (out.trim() !== '') appendFileSync(LOG, `${out}\n`)
  return out
}
/**
 * 在容器里以 user 执行（默认平台用户 eos），返回输出和退出码（不抛错：退出码本身是要核对的结果）。
 * 接口返回的值（worktree 路径、提交号）作为位置参数 $1、$2… 传进去，不拼进脚本。
 */
const inContainer = (script: string, user = 'eos', ...args: string[]): { code: number; out: string } => {
  try {
    return { code: 0, out: compose('exec', '-T', '-u', user, 'eos', 'bash', '-c', script, 'bash', ...args) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    appendFileSync(LOG, `${out}\n`)
    return { code: err.status ?? -1, out }
  }
}
const api = async (path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as any }
}
const until = async (what: string, ok: () => Promise<boolean>, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`等待超时：${what}`)
}

const REQUEST = [
  '在 src/math.js 里实现并导出一个求和函数 sum，接收一个数字数组，返回总和；空数组返回 0；数组里有非数字时抛出 TypeError。',
  '为它写 node:test 测试（放在 test/ 目录），`npm test` 必须通过。',
].join('\n')
const REPO = '/data/repos/demo'

compose('build')
compose('down', '-v')
try {
  compose('up', '-d')
  await until('Web 服务起来', async () => (await fetch(`${BASE}/api/tasks`)).status === 200, 120_000)
  // eos 命令要从 root 起：它降到 eos 时带上切换用户的能力，doctor 才测得到检查命令能不能切换到 eos-check。
  const doctor = inContainer('eos doctor', 'root')
  log(doctor.out)
  const env = inContainer('id; node -v; npm -v; pnpm -v; git --version; python3 --version; gcc --version | head -1; bwrap --version; echo "EOS_HOME=$EOS_HOME"')

  inContainer([
    `rm -rf ${REPO} && mkdir -p ${REPO} && cd ${REPO}`,
    'git init -q -b main',
    // pretest 记下跑过 npm test 的用户（每个用户一个文件，不用写别人的文件）：agent 在沙箱里跑的是 eos，平台的检查命令应该是 eos-check。
    `printf '%s\\n' '{ "name": "demo", "type": "module", "scripts": { "pretest": "touch /tmp/eos-e2e-npm-test-by-$(id -un)", "test": "node --test" } }' > package.json`,
    'git add . && git -c user.name=e2e -c user.email=e2e@localhost commit -q -m init',
  ].join(' && '))

  const created = await api('/api/tasks', { repo: REPO, workflow: 'standard', request: REQUEST })
  log(`POST /api/tasks → ${created.status} ${JSON.stringify(created.body)}`)
  if (created.status !== 201) throw new Error('任务没有建起来')
  const id = created.body.id as string
  const answered: string[] = []
  let task: any
  // 任务运行、真实的 dsh 进程还在时，以检查命令的用户（eos-check，和检查命令一样没有特权）扫一遍别的进程的环境。
  let scan: { code: number; out: string } | undefined
  let dshPids: number[] = []
  await until('任务结束', async () => {
    task = (await api(`/api/tasks/${id}`)).body
    // [d] 让 pgrep 不匹配到执行它的 bash 自己。
    const found = scan === undefined ? inContainer("pgrep -u eos-agent -f '@deepseek-ai/[d]sh/'") : undefined
    if (found?.code === 0) {
      dshPids = found.out.trim().split('\n').map(Number)
      scan = inContainer('cd /tmp && node /app/scripts/check-user-scan.mjs', 'eos-check')
    }
    if (task.status === 'waiting_user' && task.question !== undefined && !answered.includes(task.question.id)) {
      const text = task.question.options?.[0] ?? '按你的建议做'
      const a = await api(`/api/tasks/${id}/answer`, { questionId: task.question.id, text })
      log(`回答「${task.question.text}」：${text} → ${a.status}`)
      answered.push(task.question.id)
      if (a.body.resumeNeeded === true) log(`继续 → ${(await api(`/api/tasks/${id}/resume`, {})).status}`)
    }
    return ['done', 'failed', 'aborted'].includes(task.status)
  }, 40 * 60_000)
  log(`任务 ${id}：${task.status}${task.failure === undefined ? '' : `（${JSON.stringify(task.failure)}）`}`)

  // 接口返回的值先核对形状，再交给容器里的命令。
  const worktree = String(task.worktree)
  const baseSha = String(task.baseSha)
  if (!/^\/data\/worktrees\/[A-Za-z0-9_-]+$/.test(worktree) || !/^[0-9a-f]{7,64}$/.test(baseSha)) throw new Error(`接口返回的 worktree 或 baseSha 不像预期：${worktree} ${baseSha}`)
  const testUsers = inContainer('ls /tmp | sed -n "s/^eos-e2e-npm-test-by-//p"')
  const tests = inContainer('set -o pipefail; cd "$1" && npm test 2>&1 | tail -8', 'eos', worktree)
  const commits = inContainer('git -C "$1" log --oneline "$2..HEAD"', 'eos', worktree, baseSha)

  compose('down')
  compose('up', '-d')
  await until('重建后 Web 服务起来', async () => (await fetch(`${BASE}/api/tasks`)).status === 200, 120_000)
  const after = (await api(`/api/tasks/${id}`)).body
  const afterWorktree = inContainer('git -C "$1" log --oneline -1 && ls /data', 'eos', worktree)
  const head = commits.out.trim().split('\n')[0]?.split(' ')[0] ?? ''
  // 输出里混着别的行（例如 Node 的警告）时不让整个 E2E 在写报告之前崩掉：记成没有扫到，原始输出进报告。
  const scanned = (() => {
    try {
      return scan?.code === 0 ? JSON.parse(scan.out.trim().split('\n').findLast(l => l.startsWith('{'))!) : undefined
    } catch {
      return undefined
    }
  })()

  const checks = {
    '容器里 eos doctor 没有 ✗': doctor.code === 0,
    '检查命令的用户读不到平台和 dsh 进程环境里的主密钥、模型 key': scanned !== undefined && scanned.uid !== 10001 && scanned.secretsFoundIn.length === 0
      && dshPids.length > 0 && dshPids.every(pid => scanned.processes.some((p: any) => p.pid === pid && p.environ !== 'readable'))
      && scanned.processes.some((p: any) => p.uid === 10001 && p.environ !== 'readable'),
    'dsh 以 eos-agent 运行（读不到平台进程的环境）': scanned !== undefined && dshPids.length > 0 && dshPids.every(pid => scanned.processes.some((p: any) => p.pid === pid && p.uid === 10003)),
    'dsh 进程不带平台切换用户的能力（经 deploy/dsh-launch.mjs 清掉）': scanned !== undefined && dshPids.length > 0
      && dshPids.every(pid => scanned.processes.some((p: any) => p.pid === pid && /^0+$/.test(p.capEff ?? '') && /^0+$/.test(p.capAmb ?? ''))),
    '任务完成': task.status === 'done',
    '平台的检查命令（npm test）以 eos-check 运行': testUsers.out.split('\n').includes('eos-check'),
    'worktree 里 npm test 通过': tests.code === 0 && /ℹ fail 0/.test(tests.out),
    'agent 的改动提交到了任务分支': commits.code === 0 && commits.out.trim() !== '',
    'down 再 up 之后任务还在、状态不变': after.status === task.status && after.id === id,
    'down 再 up 之后 worktree 还在，最新提交不变': afterWorktree.code === 0 && head !== '' && afterWorktree.out.startsWith(head),
  }
  const report = { commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), uncommitted: execFileSync('git', ['status', '--porcelain', '--', 'Dockerfile', 'compose.yaml', 'deploy', 'src', 'scripts', 'package.json', 'vendor', 'web'], { cwd: ROOT, encoding: 'utf8' }).trim(), task: id, status: task.status, ...(task.failure === undefined ? {} : { failure: task.failure }), answered: answered.length, checks, environment: env.out, doctor: doctor.out, checkUserScan: { dshPids, scan: scanned ?? scan }, testUsers: testUsers.out, npmTest: tests.out, commits: commits.out, afterRecreate: afterWorktree.out }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  for (const [k, v] of Object.entries(checks)) log(`${v ? '✓' : '✗'} ${k}`)
  process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1
} catch (e) {
  // 失败时留下容器日志再清理，方便查原因。
  try {
    compose('logs', '--no-color', 'eos') // compose() 自己会把输出写进 run.log
  } catch {}
  throw e
} finally {
  // 不管成败都删掉容器和数据卷：下一次从空的数据卷开始，也不占着端口。清理本身失败时不盖掉原来的错误。
  try {
    compose('down', '-v')
  } catch (e) {
    log(`清理失败：${(e as Error).message}`)
  }
}
