// 部署镜像里的依赖安装探针：真实 dsh + 真实模型，agent 在沙箱里装 npm、pnpm、pip 依赖（含按 package.json 装 devDependencies），以磁盘上的结果为准。
// 用法：docker compose run --rm -v <本目录>:/probe:ro eos node --import tsx /probe/deps-probe.mts
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor } from '/app/src/executor/dsh.ts'

const OUT = '/data/deps-probe'
rmSync(OUT, { recursive: true, force: true })
const repo = join(OUT, 'repo'), wt = join(OUT, 'worktrees', 't1')
mkdirSync(repo, { recursive: true })
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
git(repo, 'init', '-q', '-b', 'main')
git(repo, '-c', 'user.name=p', '-c', 'user.email=p@localhost', 'commit', '-q', '--allow-empty', '-m', 'init')
git(repo, 'worktree', 'add', '-q', '-b', 'eos/t1', wt)
const ex = new DshExecutor({ dshHome: join(OUT, 'dsh'), dshBin: '/app/node_modules/@deepseek-ai/dsh/lib/bin.js', modelKey: () => process.env.DEEPSEEK_API_KEY || 'proxy-injected' })
const steps = [
  `cd ${wt} && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0 2>&1 | tail -2`,
  `cd ${wt} && mkdir -p p && cd p && npm init -y >/dev/null && npm pkg set packageManager=pnpm@9.15.0 && pnpm add is-odd@3.0.1 2>&1 | tail -2`,
  `cd ${wt} && python3 -m venv .venv && .venv/bin/pip install -q six==1.16.0 2>&1 | tail -2; .venv/bin/python -c "import six; print('six', six.__version__)"`,
  `mkdir -p /tmp/cache/native-plant && echo planted > /home/eos/.cache/native-addons/planted.txt; echo exit=$?`,
  `cd ${wt} && mkdir -p q && cd q && printf '%s' '{"name":"q","devDependencies":{"is-number":"7.0.0"}}' > package.json && npm install --no-audit --no-fund 2>&1 | tail -2; echo "NODE_ENV=[$NODE_ENV]"`,
]
const prompt = `这是一次环境探针。严格按顺序用 bash 工具执行下面每一条命令，某一步失败也继续下一步；不要申请提升权限，不要换别的写法绕过。最后把每条命令的原始输出贴出来。\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
let reply = ''
try {
  reply = (await ex.send({ key: 't1/build', nonce: 't1/build/c1', prompt, spec: { model: 'deepseek-flash', write: 'worktree', cwd: wt, profile: { denyTools: [], skills: [], mcp: [], background: false } }, ask: async () => '不需要，继续' })).text
} finally {
  await ex.close()
}
const ls = (d: string) => { try { return execFileSync('ls', ['-A', d], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return ['（不存在）'] } }
console.log(JSON.stringify({
  npm: existsSync(join(wt, 'node_modules', 'is-number', 'package.json')),
  pnpm: existsSync(join(wt, 'p', 'node_modules', 'is-odd', 'package.json')),
  npmDevDeps: existsSync(join(wt, 'q', 'node_modules', 'is-number', 'package.json')),
  pip: existsSync(join(wt, '.venv')) && execFileSync('bash', ['-c', `${wt}/.venv/bin/python -c "import six" && echo ok || echo no`], { encoding: 'utf8' }).trim() === 'ok',
  agentWroteNativeCache: existsSync('/home/eos/.cache/native-addons/planted.txt'),
  tmp: ls('/tmp'), tmpCache: ls('/tmp/cache'), nativeCache: ls('/home/eos/.cache/native-addons'),
  reply: reply.slice(-1500),
}, null, 2))
