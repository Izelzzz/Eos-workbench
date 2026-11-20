// 撤销和并发进程的竞态测试（Izelzzz/Eos-workbench#28，复现方法来自第 2 块第三轮独立审查）。
// 一个"agent 留下的"进程不停地把 worktree 里的目录 d 在"真目录（里面有越界文件 x）"和"指向 worktree 外 OUTSIDE 的链接"
// 之间原子地切换；平台同时循环执行 commitInScope（撤销越界改动）。每轮之后检查 OUTSIDE/x 还在不在。
// 修复前：平台会顺着刚换上的链接删掉 OUTSIDE/x。修复后：一次都不能删到外面（撤销可以失败、任务停下，这是"失败就关"）。
// 用法：node --import tsx scripts/revert-race.ts [轮数，默认 1000] [git.ts 路径，默认 src/runner/git.ts]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const rounds = Number(process.argv[2] ?? 1000)
const gitModule = resolve(process.argv[3] ?? join(import.meta.dirname, '..', 'src', 'runner', 'git.ts'))
const { commitInScope } = (await import(gitModule)) as typeof import('../src/runner/git.ts')

const ROOT = join(import.meta.dirname, '..')
const base = join(ROOT, '.eos', 'revert-race')
rmSync(base, { recursive: true, force: true })
const main = join(base, 'main')
const wt = join(base, 'wt')
const outside = join(base, 'OUTSIDE')
mkdirSync(main, { recursive: true })
mkdirSync(outside)
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
writeFileSync(join(main, 'README.md'), '# demo\n')
g(main, 'init', '-q', '-b', 'main')
g(main, 'add', '-A')
g(main, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init')
g(main, 'worktree', 'add', '-q', '-b', 'eos/race', wt)

// 竞态进程：两个备用名之间来回 rename 到 d（rename 是原子的）。
// 备用的真目录和链接放在 worktree 外面（同一个文件系统，rename 仍是原子的），worktree 里只出现 d 本身。
const racer = spawn(process.execPath, ['-e', `
const fs = require('fs'), path = require('path')
const [wt, outside, stage] = process.argv.slice(1)
const d = path.join(wt, 'd'), real = path.join(stage, 'real'), link = path.join(stage, 'link')
fs.mkdirSync(real, { recursive: true })
fs.writeFileSync(path.join(real, 'x'), 'x')
try { fs.symlinkSync(outside, link) } catch {}
for (;;) {
  try { fs.renameSync(real, d) } catch {}
  try { fs.renameSync(d, real) } catch {}
  try { fs.renameSync(link, d) } catch {}
  try { fs.renameSync(d, link) } catch {}
  try { if (!fs.existsSync(path.join(real, 'x')) && fs.existsSync(real)) fs.writeFileSync(path.join(real, 'x'), 'x') } catch {}
  try { if (!fs.existsSync(real) && !fs.existsSync(d)) { fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'x'), 'x') } } catch {}
  try { if (!fs.existsSync(link) && !fs.existsSync(d)) fs.symlinkSync(outside, link) } catch {}
}`, wt, outside, join(base, 'stage')], { stdio: 'ignore' })

let deletedOutside = 0
let refused = 0
let otherErrors = 0
const samples = new Map<string, number>()
try {
  for (let i = 0; i < rounds; i++) {
    writeFileSync(join(outside, 'x'), 'keep me\n')
    try {
      commitInScope(wt, ['src/**'], `round ${i}`, main)
    } catch (e) {
      if (/指向外面的链接|撤销不了|越界/.test((e as Error).message)) refused++
      else otherErrors++
      const first = (e as Error).message.split('\n')[0]!.replace(/round \d+/, 'round N').slice(0, 160)
      samples.set(first, (samples.get(first) ?? 0) + 1)
    }
    if (!existsSync(join(outside, 'x'))) deletedOutside++
  }
} finally {
  racer.kill('SIGKILL')
}
const report = { gitModule, rounds, deletedOutside, refused, otherErrors, errorSamples: Object.fromEntries([...samples].sort((a, b) => b[1] - a[1]).slice(0, 8)) }
console.log(JSON.stringify(report))
process.exit(deletedOutside === 0 ? 0 : 1)
