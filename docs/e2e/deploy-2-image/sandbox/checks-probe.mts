// 检查命令探针：在部署镜像里用平台的 runChecks（src/runner/checks.ts，环境是 checkEnv 白名单）跑 npm install 和 npm test，
// 看检查命令能不能正常跑，以及会不会在 /tmp 留下平台或 dsh 会加载的缓存。
// 用法：docker compose run --rm -v <本目录>:/probe:ro eos node --import tsx /probe/checks-probe.mts
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkEnv, runChecks } from '/app/src/runner/checks.ts'

const wt = '/data/checks-probe/wt'
rmSync('/data/checks-probe', { recursive: true, force: true })
mkdirSync(join(wt, 'test'), { recursive: true })
writeFileSync(join(wt, 'package.json'), JSON.stringify({ name: 'q', type: 'module', scripts: { test: 'node --test' }, devDependencies: { 'is-number': '7.0.0' } }))
writeFileSync(join(wt, 'test', 'a.test.js'), "import { test } from 'node:test'\nimport assert from 'node:assert'\nimport isNumber from 'is-number'\ntest('dev dep is usable', () => assert.ok(isNumber(1)))\n")
const ls = (d: string) => { try { return execFileSync('ls', ['-A', d], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return ['（不存在）'] } }
const snap = () => ({ tmp: ls('/tmp'), homeCache: ls('/home/eos/.cache'), homeNpm: ls('/home/eos/.npm') })
const before = snap()
const results = await runChecks(wt, [
  { kind: 'run', run: ['npm', 'install', '--no-audit', '--no-fund'], timeoutSec: 300 },
  { kind: 'run', run: ['npm', 'test'], timeoutSec: 120 },
])
console.log(JSON.stringify({
  checkEnvKeys: Object.keys(checkEnv(process.env)).sort(),
  results: results.map(r => ({ ...r, output: String((r as { output?: string }).output ?? '').slice(-400) })),
  before, after: snap(),
}, null, 2))
