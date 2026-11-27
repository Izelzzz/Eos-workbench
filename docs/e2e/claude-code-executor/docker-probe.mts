// 在部署镜像里实测 Claude Code 执行器的沙箱（不调真模型：模型接口是本机的假接口）。
// 由 docker-probe.sh 在容器里以平台用户 eos 运行（和 deploy/eos 一样带着 SETUID、SETGID、KILL），Docker 默认的 seccomp。
// 每条结论一行 PASS / FAIL，最后一行是失败数。
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClaudeCodeExecutor, sessionIdFor } from '/app/src/executor/claude-code.ts'
import { landlockProbe } from '/app/src/executor/landlock.ts'
import { asUser, checkUserFrom } from '/app/src/runner/check-user.ts'
import { FakeAnthropic, stepOf, type Block, type Req } from '/probe/fake-anthropic.ts'

let failed = 0
const check = (name: string, ok: boolean, evidence: unknown) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`)
}

const REAL_KEY = 'sk-ant-probe-real-key'
const data = process.env.EOS_HOME ?? '/data'
const agentUser = checkUserFrom(process.env, undefined, 'EOS_AGENT_USER')
check('平台以 eos 运行，agent 的用户是 eos-agent', execFileSync('id', ['-un'], { encoding: 'utf8' }).trim() === 'eos' && agentUser?.name === 'eos-agent', { agentUser: agentUser?.name })
check('部署镜像里 Landlock 可用（Docker 默认 seccomp）', landlockProbe() === 'full', landlockProbe())
const st = statSync(join(data, 'claude-code'))
check('deploy/eos 建好了 claude-code 目录（组 eos-dsh、3770）', (st.mode & 0o7777) === 0o3770, (st.mode & 0o7777).toString(8))

const fake = new FakeAnthropic()
const url = await fake.start()
const script =
  (...steps: ((r: Req) => Block[])[]) =>
  (r: Req): Block[] =>
    (steps[stepOf(r)] ?? (() => [{ text: '完成' }]))(r)

// worktree 和平台建的一样：组 eos-work、组内可写、setgid
const ws = join(data, 'worktrees', `probe-${process.pid}`)
mkdirSync(ws, { recursive: true })
execFileSync('chgrp', ['eos-work', ws])
execFileSync('chmod', ['2775', ws])
const secret = join(data, `platform-secret-${process.pid}.txt`)
writeFileSync(secret, 'platform only', { mode: 0o600 })

const ex = new ClaudeCodeExecutor({ home: join(data, 'claude-code'), modelKey: () => REAL_KEY, target: url, env: process.env, ...(agentUser === undefined ? {} : { agentUser }) })
const profile = {
  builtinTools: 'standard' as const,
  denyTools: [],
  skills: [{ name: 'codeword', content: '---\nname: codeword\ndescription: 问暗号时用\n---\n暗号是 SK-DOCK。\n' }],
  mcp: [],
  background: false,
}
const ask = async () => ''

const cmd = [
  `id -un > ${ws}/whoami.txt`,
  `echo x > ${ws}/in.txt`,
  `echo x > ${data}/escape.txt`,
  `echo x > /app/escape.txt`,
  `echo x > /home/eos-agent/escape.txt`,
  `cat ${secret} > ${ws}/secret.txt 2>&1`,
  `{ echo "$ANTHROPIC_API_KEY"; tr '\\0' '\\n' < /proc/$PPID/environ; for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null; done; } > ${ws}/env.txt 2>&1`,
  'echo done',
].join('; ')
fake.reply = script(() => [{ tool: 'Bash', input: { command: cmd } }])
const from = fake.requests.length
const r = await ex.send({ key: 'probe/dev', spec: { write: 'worktree', cwd: ws, profile }, prompt: '实测', nonce: 'n1', ask })
const env = readFileSync(join(ws, 'env.txt'), 'utf8')
check('可写的角色：命令以 eos-agent 运行', readFileSync(join(ws, 'whoami.txt'), 'utf8').trim() === 'eos-agent', readFileSync(join(ws, 'whoami.txt'), 'utf8').trim())
check('可写的角色：能写自己的 worktree', existsSync(join(ws, 'in.txt')), existsSync(join(ws, 'in.txt')))
check('可写的角色：写不了数据目录、/app、eos-agent 的家目录', !existsSync(join(data, 'escape.txt')) && !existsSync('/app/escape.txt') && !existsSync('/home/eos-agent/escape.txt'), {
  data: existsSync(join(data, 'escape.txt')),
  app: existsSync('/app/escape.txt'),
  home: existsSync('/home/eos-agent/escape.txt'),
})
check('读不到平台的文件（0600，属于 eos）', !readFileSync(join(ws, 'secret.txt'), 'utf8').includes('platform only'), readFileSync(join(ws, 'secret.txt'), 'utf8').trim().slice(0, 120))
check(
  'agent 从自己的环境、Claude Code 进程和所有能读的进程环境里都读不到真 key、主密钥',
  !env.includes(REAL_KEY) && !env.includes(process.env.EOS_MASTER_KEY ?? 'unset-master') && /sk-ant-eos-[0-9a-f]+/.test(env),
  { realKey: env.includes(REAL_KEY), masterKey: env.includes(process.env.EOS_MASTER_KEY ?? 'unset-master'), token: /sk-ant-eos-[0-9a-f]+/.test(env) },
)
check('发到模型接口的是真 key（上游换上的）', [...new Set(fake.requests.slice(from).map(x => x.key))].join() === REAL_KEY, [...new Set(fake.requests.slice(from).map(x => x.key))])
check('平台以 eos-agent 读回会话日志，按 nonce 找回回复', (await ex.findReply('probe/dev', 'n1'))?.text === r.text, r.text)
const home = ex.sessionHome(sessionIdFor('probe/dev'))
// sessions/ 本身也是 eos-agent 的 0700：平台看不进去，只能以 eos-agent 看（和读会话日志一样）
const [statCmd, ...statArgs] = asUser(agentUser!, ['stat', '-c', '%U %a', join(data, 'claude-code', 'sessions'), home])
const owner = execFileSync(statCmd!, statArgs, { encoding: 'utf8' }).trim().split('\n').join(' | ')
const platformSees = (() => {
  try {
    statSync(home)
    return 'stat 成功'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? 'error'
  }
})()
check('平台自己（eos）看不进会话目录', platformSees === 'EACCES', platformSees)
// 2700：setgid 是从 claude-code 目录（3770）继承的，只有属主能进
check('sessions/ 和会话目录都属于 eos-agent、只有它能进（2700）', owner === 'eos-agent 2700 | eos-agent 2700', owner)

// 只读的角色
fake.reply = script(() => [{ tool: 'Bash', input: { command: `echo x > ${ws}/ro.txt; echo done` } }])
await ex.send({ key: 'probe/review', spec: { write: 'none', cwd: ws, profile }, prompt: '实测', nonce: 'n1', ask })
check('只读的角色：写不了 worktree', !existsSync(join(ws, 'ro.txt')), existsSync(join(ws, 'ro.txt')))

// 技能：插件目录由平台写、agent 读
let sent = ''
fake.reply = script(
  () => [{ tool: 'Skill', input: { skill: 'eos:codeword' } }],
  q => ((sent = JSON.stringify(q.body.messages)), [{ text: '完成' }]),
)
await ex.send({ key: 'probe/skill', spec: { write: 'worktree', cwd: ws, profile }, prompt: '用技能', nonce: 'n1', ask })
check('平台给的技能在镜像里能用（插件目录 agent 只读）', sent.includes('SK-DOCK'), sent.includes('SK-DOCK'))

// ---- 上游只认这次调用的令牌：别的任务的 agent、检查命令（eos-check）都用不了 ----
const checkUser = checkUserFrom(process.env, undefined, 'EOS_CHECK_USER')!
const base = /^ANTHROPIC_BASE_URL=(.+)$/m.exec(env)![1]!
const expired = /sk-ant-eos-[0-9a-f]+/.exec(env)![0]
/** 以 user 运行一段 node 脚本（对上游发请求），输出它打印的一行。异步：上游就在这个进程里，同步等会卡死它。 */
const asNode = async (user: NonNullable<typeof checkUser>, code: string): Promise<string> => {
  const [c, ...a] = asUser(user, [process.execPath, '-e', code])
  return (await promisify(execFile)(c!, a, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } })).stdout.trim()
}
const tryUpstream = (token: string) =>
  `fetch(${JSON.stringify(`${base}/v1/messages`)}, { method: 'POST', headers: { 'content-type': 'application/json'${token === '' ? '' : `, 'x-api-key': ${JSON.stringify(token)}`} }, body: '{}' }).then(r => r.status, e => 'ERR ' + e.message)`
// 任务 A 的调用一直在跑（它的令牌有效）；同时任务 B 的 agent 在自己的调用里找别人的令牌、拿过期的令牌和不带令牌去连上游
const wsB = join(data, 'worktrees', `probe-b-${process.pid}`)
mkdirSync(wsB, { recursive: true })
execFileSync('chgrp', ['eos-work', wsB])
execFileSync('chmod', ['2775', wsB])
let releaseA!: () => void
const holdA = new Promise<void>(ok => (releaseA = ok))
let aStarted!: () => void
const aRunning = new Promise<void>(ok => (aStarted = ok))
const scanB = [
  `own=$ANTHROPIC_API_KEY`,
  `for p in /proc/[0-9]*; do tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -o 'sk-ant-eos-[0-9a-f]*'; done | sort -u | grep -v "^$own$" > ${wsB}/others.txt`,
  `node -e '${'const t=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\\n").filter(Boolean); const go=k=>fetch(process.argv[2],{method:"POST",headers:{"content-type":"application/json",...(k?{"x-api-key":k}:{})},body:"{}"}).then(r=>r.status,e=>"ERR "+e.message); Promise.all([go(""),go(process.argv[3]),...t.map(go)]).then(s=>console.log(JSON.stringify({others:t.length,statuses:s})))'}' ${wsB}/others.txt ${base}/v1/messages ${expired} > ${wsB}/b.json 2>&1`,
  'echo done',
].join('; ')
fake.reply = (q: Req): Block[] => {
  const prompt = JSON.stringify(q.body.messages)
  const step = stepOf(q)
  if (prompt.includes('任务A')) {
    if (step === 0) {
      aStarted()
      return [{ tool: 'Bash', input: { command: `node -e "setTimeout(() => {}, 60000)"` } }]
    }
    return [{ text: '完成' }]
  }
  return step === 0 ? [{ tool: 'Bash', input: { command: scanB } }] : [{ text: '完成' }]
}
const callA = ex.send({ key: 'probe/a', spec: { write: 'worktree', cwd: ws, profile }, prompt: '任务A', nonce: 'n1', ask }).catch(e => (e as Error).message)
await aRunning
await new Promise(ok => setTimeout(ok, 1500))
await ex.send({ key: 'probe/b', spec: { write: 'worktree', cwd: wsB, profile }, prompt: '任务B', nonce: 'n1', ask })
const b = JSON.parse(readFileSync(join(wsB, 'b.json'), 'utf8')) as { others: number; statuses: unknown[] }
check('别的任务的 agent 读不到正在跑的任务的令牌（别的 Claude Code 进程的环境）', b.others === 0, b)
check('别的任务的 agent：不带令牌、带过期的令牌连上游都被拒（401）', b.statuses.length === 2 && b.statuses.every(x => x === 401), b.statuses)
// 检查命令（eos-check）：A 的调用还在跑时，不带令牌、带过期的令牌都被拒；也读不到 Claude Code 进程的环境
const viaCheck = [await asNode(checkUser, `${tryUpstream('')}.then(console.log)`), await asNode(checkUser, `${tryUpstream(expired)}.then(console.log)`)]
check(
  '检查命令（eos-check）：不带令牌、带过期的令牌连上游都被拒（401）',
  viaCheck.every(x => x === '401'),
  viaCheck,
)
const ccPids = execFileSync('sh', ['-c', 'for p in /proc/[0-9]*; do tr "\\000" " " < $p/cmdline 2>/dev/null | grep -q "claude-agent-sdk-linux" && echo ${p#/proc/}; done; exit 0'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter(Boolean)
const readable = await asNode(
  checkUser,
  `const fs=require('fs'); console.log(JSON.stringify(${JSON.stringify(ccPids)}.map(p => { try { return /sk-ant-eos/.test(fs.readFileSync('/proc/'+p+'/environ','utf8')) ? 'token' : 'no-token' } catch (e) { return e.code } })))`,
)
// ENOENT：列出之后已经退出的进程（例如任务 B 的）
check(
  '检查命令读不到正在跑的 Claude Code 进程的环境',
  ccPids.length > 0 && (JSON.parse(readable) as string[]).includes('EACCES') && (JSON.parse(readable) as string[]).every(x => x === 'EACCES' || x === 'ENOENT'),
  { pids: ccPids.length, readable },
)
await ex.release(ws)
releaseA()
await holdA
await callA

await ex.close()
await fake.close()
console.log(`failed=${failed}`)
process.exit(failed === 0 ? 0 : 1)
