// 从检查命令的位置看能读到什么：平台用 runChecks（沙箱外、平台用户）跑一条检查命令，此时 dsh 进程还在运行。
// - 平台进程：初始环境里有 EOS_MASTER_KEY（由 docker compose run -e 传入标记），启动后像 cli.ts 一样从 process.env 删掉。
// - dsh 进程：环境里有模型 key（用标记当 key）。
// 检查命令在所有 /proc/<pid>/environ 里找这两个标记。用法：
// docker compose run --rm -e EOS_MASTER_KEY=MASTERKEY_MARKER_4b2d -v <本目录>:/probe:ro eos node --import tsx /probe/checks-env-probe.mts
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor } from '/app/src/executor/dsh.ts'
import { runChecks } from '/app/src/runner/checks.ts'

const MASTER = process.env.EOS_MASTER_KEY ?? ''
delete process.env.EOS_MASTER_KEY // 和 cli.ts 的 takeMasterKey 一样：之后起的子进程继承不到
const MODEL = 'MODELKEY_MARKER_9c1e'
const OUT = '/data/checks-env-probe'
rmSync(OUT, { recursive: true, force: true })
const repo = join(OUT, 'repo'), wt = join(OUT, 'worktrees', 't1')
mkdirSync(repo, { recursive: true })
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
git(repo, 'init', '-q', '-b', 'main')
git(repo, '-c', 'user.name=p', '-c', 'user.email=p@localhost', 'commit', '-q', '--allow-empty', '-m', 'init')
git(repo, 'worktree', 'add', '-q', '-b', 'eos/t1', wt)
const ex = new DshExecutor({ dshHome: join(OUT, 'dsh'), dshBin: '/app/node_modules/@deepseek-ai/dsh/lib/bin.js', modelKey: () => MODEL })
let results
try {
  // 起一次调用，让 dsh 进程运行起来；调用结束后 dsh 进程仍在（直到 close）。
  await ex.send({ key: 't1/build', nonce: 't1/build/c1', prompt: '回复“好”即可，不要调用工具。', spec: { model: 'deepseek-flash', write: 'worktree', cwd: wt, profile: { denyTools: [], skills: [], mcp: [], background: false } }, ask: async () => '继续' })
  const sh = [
    `echo "platform_pid=$PPID"`,
    `echo "master_key_hits=$(grep -sl ${MASTER} /proc/[0-9]*/environ | tr '\\n' ' ')"`,
    `echo "model_key_hits=$(grep -sl ${MODEL} /proc/[0-9]*/environ | tr '\\n' ' ')"`,
    `for f in $(grep -sl ${MODEL} /proc/[0-9]*/environ); do p=\${f#/proc/}; p=\${p%/environ}; echo "model_key_in: $p $(tr '\\0' ' ' < /proc/$p/cmdline | cut -c1-80)"; done`,
    `echo "self_env_has_master=$(env | grep -c ${MASTER})"`,
    'exit 1', // 平台只在检查失败时记下输出
  ].join('; ')
  results = await runChecks(wt, [{ kind: 'run', run: ['bash', '-c', sh], timeoutSec: 60 }])
} finally {
  await ex.close()
}
console.log(JSON.stringify({ masterMarkerSet: MASTER !== '', check: results.map(r => ({ passed: r.passed, detail: r.detail })) }, null, 2))
