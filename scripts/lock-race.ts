// 锁的真实竞争测试：每轮放一把过期的锁，10 个进程等到同一个绝对时间点一起抢，赢家必须恰好一个。
// 方法来自第 2 次独立审查。每轮约 4 秒，所以不放进 npm test。
// 用法：node --import tsx scripts/lock-race.ts [轮数] [lock.ts 路径，默认 src/runner/lock.ts]
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const rounds = Number(process.argv[2] ?? 30)
const lockModule = resolve(process.argv[3] ?? join(import.meta.dirname, '..', 'src', 'runner', 'lock.ts'))
const PROCS = 10
const child = `const { acquire } = await import(${JSON.stringify(lockModule)});
const [dir, at] = [process.argv[1], Number(process.argv[2])];
while (Date.now() < at) {}
const r = acquire(dir, 't');
console.log('release' in r ? 'won' : 'lost');
if ('release' in r) await new Promise(x => setTimeout(x, 1500));`

let bad = 0
for (let round = 0; round < rounds; round++) {
  const d = mkdtempSync(join(tmpdir(), 'eos-lock-race-'))
  writeFileSync(join(d, 't.pid'), '999999999') // 上一个 runner 被 SIGKILL 后留下的锁
  const at = Date.now() + 2500
  const results = await Promise.all(Array.from({ length: PROCS }, () => new Promise<string>(ok => {
    const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child, d, String(at)], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', c => (out += c))
    p.on('exit', () => ok(out.trim()))
  })))
  const winners = results.filter(r => r === 'won').length
  if (winners !== 1) {
    bad++
    console.log(`第 ${round + 1} 轮：${winners} 个赢家`)
  }
  rmSync(d, { recursive: true, force: true })
}
console.log(`${lockModule}：${rounds} 轮，${PROCS} 个进程同时抢，出错 ${bad} 轮`)
process.exit(bad === 0 ? 0 : 1)
