// 模型 key 探针：dsh 进程的环境里有模型 key（DEEPSEEK_API_KEY）。用唯一的标记当 key，让 agent 的 bash 在所有可见进程的
// /proc/<pid>/environ 里找它，看 agent 能不能读到 dsh 进程的环境。同时记下沙箱是哪个后端（看 /tmp 是不是私有的）。
// 认证由出网代理完成，标记当 key 也能调用模型。
// 用法：docker compose run --rm -v <本目录>:/probe:ro eos node --import tsx /probe/modelkey-probe.mts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor } from '/app/src/executor/dsh.ts'

const KEY = 'MODELKEY_MARKER_9c1e'
const OUT = '/data/modelkey-probe'
rmSync(OUT, { recursive: true, force: true })
const repo = join(OUT, 'repo'), wt = join(OUT, 'worktrees', 't1')
mkdirSync(repo, { recursive: true })
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
git(repo, 'init', '-q', '-b', 'main')
git(repo, '-c', 'user.name=p', '-c', 'user.email=p@localhost', 'commit', '-q', '--allow-empty', '-m', 'init')
git(repo, 'worktree', 'add', '-q', '-b', 'eos/t1', wt)
const ex = new DshExecutor({ dshHome: join(OUT, 'dsh'), dshBin: '/app/node_modules/@deepseek-ai/dsh/lib/bin.js', modelKey: () => KEY })
const out = join(wt, 'env-report.txt')
const script = [
  `echo "visible_pids=$(ls /proc | grep -c '^[0-9]')"`,
  `echo "key_hits=$(grep -sl ${KEY} /proc/[0-9]*/environ | wc -l)"`,
  `echo "key_hit_pids=$(grep -sl ${KEY} /proc/[0-9]*/environ | tr '\\n' ' ')"`,
  `echo "parent_environ_readable=$(cat /proc/$PPID/environ >/dev/null 2>&1 && echo yes || echo no)"`,
  `echo "self_has_key=$(grep -c ${KEY} /proc/self/environ)"`,
  `echo "probe-tmp" > /tmp/probe-tmp.txt`,
].join('; ')
const prompt = `这是一次环境探针。用 bash 工具原样执行下面这条命令（一条命令，不要拆开、不要改写），然后把输出原样贴出来；不要申请提升权限。\n( ${script} ) > ${out} 2>&1; cat ${out}`
try {
  await ex.send({ key: 't1/build', nonce: 't1/build/c1', prompt, spec: { model: 'deepseek-flash', write: 'worktree', cwd: wt, profile: { denyTools: [], skills: [], mcp: [], background: false } }, ask: async () => '不需要，继续' })
} finally {
  await ex.close()
}
// 正对照：dsh 已经退出，另起一个同用户、不在沙箱里的进程，环境里带标记，确认 grep 的写法能找到它。
const control = execFileSync('bash', ['-c', `sleep 5 & sleep 0.3; grep -sl ${KEY} /proc/[0-9]*/environ | wc -l`], { encoding: 'utf8', env: { ...process.env, X: KEY } }).trim()
console.log(JSON.stringify({
  agentReport: existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : '（没写出来）',
  agentWroteRealTmp: existsSync('/tmp/probe-tmp.txt'),
  positiveControlHits: control,
}, null, 2))
