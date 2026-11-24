// M1 端到端验证：用真实的 deepseek-flash 跑 feature 模板，验证 M1 的完成标准。
// 1. 在 .eos/e2e/repo 建一个示例仓库，通过 CLI 发起任务；
// 2. agent 提问时用 `eos answer`（另一个进程）回答；
// 3. 开发第一次完成后 SIGKILL 掉 runner，再用 `eos resume` 续跑；
// 4. 跑完后从存储里逐条检查，结果写到 .eos/e2e/report.json，完整输出在 .eos/e2e/run.log。
// 设置 EOS_E2E_REPO=https://github.com/<owner>/<repo> 时不建本地示例仓库，在这个远程仓库上跑（它要有同样的 package.json 和 src/math.js）：
// 先把 EOS_E2E_GIT_TOKEN 存进凭据存储（名字是主机名，需要 EOS_MASTER_KEY）。工作流用 feature-pr：feature 加一个交付节点，平台推送任务分支并开 PR。
// 跑完多核对任务记下了远程仓库、数据目录里找不到令牌、远程的任务分支和本地一致、开了 PR 且再开一次会复用同一个。
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSessionLog, sessionIdFor } from '../src/executor/dsh.ts'
import { keyOf } from '../src/runner/runner.ts'
import { parseMasterKey, takeMasterKey } from '../src/credentials/key.ts'
import { MODEL_KEY_CREDENTIAL } from '../src/credentials/model-key.ts'
import { Credentials } from '../src/credentials/store.ts'
import { LOCAL_OWNER } from '../src/credentials/types.ts'
import { defaultForges, parseRemote } from '../src/forge/forges.ts'
import { Conventions } from '../src/conventions/conventions.ts'
import { Store } from '../src/store/store.ts'

const ROOT = join(import.meta.dirname, '..')
const E2E = join(ROOT, '.eos', 'e2e')
const REPO = join(E2E, 'repo')
const DATA = join(E2E, 'data')
const LOG = join(E2E, 'run.log')

const REQUEST = [
  '在 src/math.js 里实现并导出一个求和函数，接收一个数字数组，返回总和；空数组返回 0；数组里有非数字时抛出 TypeError。',
  '为它写 node:test 测试（放在 test/ 目录），`npm test` 必须通过。',
  '函数名还没定：规划阶段先用 ask_user_question 工具问我用 sum 还是 total。',
  '（E2E 验证要求：评审第一轮必须至少提出一条 major 意见，例如补充边界情况的测试，以验证对话循环。）',
].join('\n')

// 设置了 EOS_E2E_STORE_KEY 时，模型 key 只放进凭据存储（名为 deepseek，用 EOS_MASTER_KEY 加密），平台进程的环境里没有 DEEPSEEK_API_KEY。
const storeKey = process.env.EOS_E2E_STORE_KEY
const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: '1', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'proxy-injected' }
delete env.EOS_E2E_STORE_KEY
if (storeKey !== undefined) delete env.DEEPSEEK_API_KEY
const REMOTE = process.env.EOS_E2E_REPO
const GIT_TOKEN = process.env.EOS_E2E_GIT_TOKEN
const MASTER_KEY = process.env.EOS_MASTER_KEY
const record = (s: string) => {
  process.stdout.write(s)
  appendFileSync(LOG, s)
}

const setupRepo = () => {
  rmSync(E2E, { recursive: true, force: true })
  mkdirSync(join(REPO, 'src'), { recursive: true })
  writeFileSync(join(REPO, 'package.json'), JSON.stringify({ name: 'e2e-sample', type: 'module', scripts: { test: 'node --test' } }, null, 2))
  writeFileSync(join(REPO, 'src', 'math.js'), '// 数学工具函数\n')
  const git = (...a: string[]) => execFileSync('git', a, { cwd: REPO })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', 'commit', '-q', '-m', 'init')
  if (storeKey !== undefined) {
    const master = parseMasterKey(process.env.EOS_MASTER_KEY)
    if (master.kind !== 'ok') throw new Error('EOS_E2E_STORE_KEY 需要同时设置有效的 EOS_MASTER_KEY')
    mkdirSync(DATA, { recursive: true })
    const c = new Credentials(join(DATA, 'eos.db'), master.key)
    const put = c.put(LOCAL_OWNER, MODEL_KEY_CREDENTIAL, 'api-key', storeKey)
    c.close()
    if (!put.ok) throw new Error(put.error)
  }
}

const cli = (args: string[]) => spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args, '--data', DATA], { cwd: ROOT, env })

const answer = (id: string, text: string) =>
  execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), 'answer', id, text, '--data', DATA], { cwd: ROOT, env, encoding: 'utf8' })

/** 运行一个 CLI 进程，遇到提问就回答；killAfter 匹配到某一行时 SIGKILL。返回任务 id 与是否被杀。 */
const drive = (args: string[], opts: { killAfter?: RegExp } = {}) => new Promise<{ id: string; killed: boolean }>((resolve, reject) => {
  const child = cli(args)
  let id = args[0] === 'resume' ? args[1]! : ''
  let buffer = ''
  let killed = false
  const onLine = (line: string) => {
    const created = /^任务 (t\w+)：工作流/.exec(line)
    if (created) id = created[1]!
    if (line.startsWith('？ agent 提问')) {
      // 有选项就选第一个（原文照抄，执行器才会按"选中选项"回传），没有选项才回答 sum。
      const options = /（选项：(.+)）$/.exec(line)?.[1]?.split(' / ')
      const reply = options?.[0] ?? 'sum'
      const out = answer(id, reply)
      record(`[e2e] 用户回答「${reply}」：${out}`)
    }
    if (line.startsWith('待回答')) {
      const out = answer(id, '按评审意见改，保留 sum 这个名字')
      record(`[e2e] 用户回答对话尽头的问题：${out}`)
    }
    if (!killed && opts.killAfter?.test(line)) {
      killed = true
      record(`\n[e2e] 匹配到「${line}」，SIGKILL runner（pid ${child.pid}）\n\n`)
      child.kill('SIGKILL')
    }
  }
  const take = (chunk: Buffer) => {
    record(chunk.toString())
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()!
    lines.forEach(onLine)
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  child.on('error', reject)
  child.on('exit', () => resolve({ id, killed }))
})

const remote = REMOTE === undefined ? undefined : parseRemote(defaultForges(), REMOTE)
if (REMOTE !== undefined && remote === undefined) throw new Error(`认不出 EOS_E2E_REPO：${REMOTE}`)
if (remote === undefined) setupRepo()
else {
  rmSync(E2E, { recursive: true, force: true })
  mkdirSync(DATA, { recursive: true })
  if (GIT_TOKEN !== undefined) {
    const key = takeMasterKey({ EOS_MASTER_KEY: MASTER_KEY })
    if (key.kind !== 'ok') throw new Error('EOS_E2E_GIT_TOKEN 需要有效的 EOS_MASTER_KEY')
    const c = new Credentials(join(DATA, 'eos.db'), key.key)
    const put = c.put(LOCAL_OWNER, remote.forge.credentialName(remote.repo), 'token', GIT_TOKEN)
    c.close()
    if (!put.ok) throw new Error(put.error)
  }
  // feature 加一个交付节点：平台推送任务分支并开 PR。
  const feature = readFileSync(join(ROOT, 'src', 'workflow', 'templates', 'feature.yaml'), 'utf8')
  const push = `${feature.replace(/^name: feature$/m, 'name: feature-pr').trimEnd()}\n  - id: deliver\n    kind: dialog\n    with: build\n    task: 平台推送任务分支并开 PR。\n    maxRounds: 1\n    checks:\n      - { platform: pull-request }\n`
  const seedStore = new Store(join(DATA, 'eos.db'))
  const conventions = new Conventions(seedStore)
  conventions.seed(Date.now())
  const saved = conventions.save({ kind: 'workflow', name: 'feature-pr', content: push, actor: 'e2e' }, Date.now())
  seedStore.close()
  if (!saved.ok) throw new Error(`保存 feature-pr 失败：${JSON.stringify(saved)}`)
}
writeFileSync(LOG, `# M1 E2E ${new Date().toISOString()}\n# 需求：\n${REQUEST}\n\n`)
const first = await drive(['run', '--repo', REMOTE ?? REPO, '--workflow', remote === undefined ? 'feature' : 'feature-pr', REQUEST], { killAfter: /^✓ \[build\] dev|^✓ \[build\] developer/ })
if (!first.killed) record('\n[e2e] 警告：没有在开发完成后杀掉进程\n')
await drive(['resume', first.id])

const store = new Store(join(DATA, 'eos.db'))
const task = store.get(first.id)!
const calls = task.log.filter(e => e.type === 'call')
const ids = calls.map(c => c.call)
const meta = store.meta(first.id)
const testRun = (() => {
  try {
    return { ok: true, out: execFileSync('npm', ['test'], { cwd: meta.worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).slice(-400) }
  } catch (e) {
    return { ok: false, out: String((e as { stdout?: string }).stdout ?? e).slice(-400) }
  }
})()
/** 远程仓库：任务记下了远程仓库，worktree 建在镜像上；数据目录里的任何文件都找不到令牌。 */
function remoteChecks(): Record<string, boolean> {
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []))
  // 原始令牌，和它在认证头里的 base64 形式。
  const forms = GIT_TOKEN === undefined ? [] : [GIT_TOKEN, Buffer.from(`x-access-token:${GIT_TOKEN}`).toString('base64')]
  const leaked = files(DATA).filter(f => { const b = readFileSync(f); return forms.some(x => b.includes(x)) })
  const localHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: meta.worktree, encoding: 'utf8' }).trim()
  const remoteHead = execFileSync('git', ['ls-remote', remote!.repo.cloneUrl, `refs/heads/${meta.branch}`], { encoding: 'utf8' }).split('\t')[0]!.trim()
  const pushResult = task.log.flatMap(e => (e.type === 'check' ? e.results : [])).filter(r => r.check.kind === 'platform').at(-1)
  record(`\n[e2e] 本地任务分支 ${localHead}，远程 ${remoteHead}；推送检查：${pushResult?.detail ?? '（没有）'}\n`)
  const prLink = (pushResult?.links ?? []).find(l => l.kind === 'pull-request')
  // 再开一次（模拟重跑交付）和查这个分支打开的 PR：在走代理的子进程里调平台的同一个函数和 GitHub 的接口。
  const probe = `import { defaultForges, parseRemote } from ${JSON.stringify(join(ROOT, 'src', 'forge', 'forges.ts'))}
const { repo, forge } = parseRemote(defaultForges(), ${JSON.stringify(REMOTE)})
const again = await forge.openPullRequest(repo, process.env.EOS_PROBE_TOKEN || undefined, { head: ${JSON.stringify(meta.branch)}, base: ${JSON.stringify(meta.baseBranch ?? 'main')}, sha: ${JSON.stringify(localHead)}, title: 'e2e 重开', body: 'e2e' })
const list = await (await fetch(\`https://api.github.com/repos/\${repo.owner}/\${repo.name}/pulls?state=open&head=\${repo.owner}:${meta.branch}\`, { headers: { authorization: \`Bearer \${process.env.EOS_PROBE_TOKEN ?? ''}\`, 'user-agent': 'eos-e2e' } })).json()
process.stdout.write(JSON.stringify({ again, openCount: Array.isArray(list) ? list.length : -1 }))`
  let again: { reused: boolean; url: string } | undefined
  let openCount = -1
  try {
    const out = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { cwd: ROOT, env: { ...process.env, NODE_USE_ENV_PROXY: '1', EOS_PROBE_TOKEN: GIT_TOKEN ?? '' }, encoding: 'utf8' })) as { again: { reused: boolean; url: string }; openCount: number }
    again = out.again
    openCount = out.openCount
  } catch (e) {
    // 报错里有子进程的命令行（探测代码本身），不带令牌；保险起见再抹一次。
    record(`\n[e2e] 再开一次 PR 失败：${GIT_TOKEN === undefined || GIT_TOKEN === '' ? (e as Error).message : (e as Error).message.split(GIT_TOKEN).join('***')}\n`)
  }
  record(`[e2e] PR：${prLink?.url ?? '（没有）'}；再开一次：${JSON.stringify(again)}；这个分支打开的 PR：${openCount} 个\n`)
  if (leaked.length > 0) record(`\n[e2e] 令牌出现在：${leaked.join('、')}\n`)
  return {
    '任务记下了远程仓库': JSON.stringify(meta.remote) === JSON.stringify(remote!.repo),
    'worktree 建在平台数据目录里的镜像上': meta.repo.startsWith(join(DATA, 'repos')),
    '数据目录里找不到令牌和认证头（数据库、镜像、worktree、dsh 会话、日志）': GIT_TOKEN !== undefined && leaked.length === 0,
    '远程的任务分支和本地任务分支是同一个提交': remoteHead === localHead && localHead !== '',
    '推送检查通过并带着分支链接': pushResult?.passed === true && (pushResult.links ?? []).some(l => l.url === remote!.forge.branchUrl(remote!.repo, meta.branch)),
    '开了 PR，检查结果带着 PR 链接': prLink !== undefined && /\/pull\/\d+$/.test(prLink.url),
    '同一个分支再开一次：复用同一个 PR，GitHub 上这个分支打开的 PR 只有一个': again?.reused === true && again.url === prLink?.url && openCount === 1,
  }
}

/** dsh 会话日志里，每个会话收到过哪些调用（按消息里的 nonce）以及它的权限档位变化。 */
const sessionLog = (session: string) => {
  const sid = sessionIdFor(keyOf(first.id, session))
  const root = join(DATA, 'dsh', 'sessions')
  const dir = readdirSync(root).find(d => existsSync(join(root, d, sid)))!
  const events = parseSessionLog(readFileSync(join(root, dir, sid, 'session.v4.jsonl.zstd'))) ?? []
  const calls = events.filter(e => e.type === 'user/message').map(e => /eos:[^/]+\/(c\d+) -->/.exec(JSON.stringify(e.data))?.[1]).filter(Boolean)
  const presets = events.filter(e => e.type === 'permission/preset').map(e => e.data?.preset ?? e.data?.name)
  const asks = events.filter(e => e.type === 'tool/call' && e.data?.name === 'ask_user_question').length
  return { sid, calls, presets, asks }
}
const sessions = Object.fromEntries(['plan', 'build', 'review'].map(s => [s, sessionLog(s)]))
const devCalls = calls.filter(c => c.role === 'developer').map(c => c.call)
const checks = {
  '任务完成': task.status === 'done',
  '评审至少打回一次，开发回应': calls.some(c => c.purpose === 'respond'),
  '开发的每次调用都在同一个 dsh 会话里': devCalls.length >= 2 && devCalls.every(c => sessions.build!.calls.includes(c)),
  '规划和评审是只读档位，开发是 workspace-write': sessions.plan!.presets.at(-1) === 'read-only' && sessions.review!.presets.at(-1) === 'read-only' && sessions.build!.presets.at(-1) === 'workspace-write',
  'agent 主动提问并收到回答': task.log.some(e => e.type === 'question' && e.question.source === 'agent') && task.log.some(e => e.type === 'answer'),
  '杀进程后续跑：没有重复记录同一个调用': new Set(ids).size === ids.length,
  '耗时和 token 都有记录': calls.every(c => c.ms > 0 && c.usage.input + c.usage.cacheRead > 0),
  'worktree 里 npm test 通过': testRun.ok,
  ...(remote === undefined ? {} : remoteChecks()),
}
const resent = store.events(first.id).filter(e => e.event.kind === 'replied' && !e.accepted).length
const result = { task: first.id, killed: first.killed, checks, sessions, rejectedReplies: resent, calls: calls.map(c => `${c.call} ${c.purpose}@${c.node}${c.round ? `#${c.round}` : ''} ${c.ms}ms`), commits: execFileSync('git', ['log', '--oneline', `${meta.baseSha}..HEAD`], { cwd: meta.worktree, encoding: 'utf8' }), npmTest: testRun.out }
writeFileSync(join(E2E, 'report.json'), JSON.stringify(result, null, 2))
record(`\n[e2e] 结果：\n${JSON.stringify(result, null, 2)}\n`)
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
