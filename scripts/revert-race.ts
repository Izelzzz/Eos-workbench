// 撤销和并发进程的竞态测试（Izelzzz/Eos-workbench#28，复现方法来自第 2 块第三轮审查和 #28 的独立审查）。
// 一个"agent 留下的"进程不停地把 worktree 里的目录 d 在"真目录"和"指向 worktree 外 OUTSIDE 的链接"之间原子地切换，
// 平台同时循环执行 commitInScope（撤销越界改动）。两个场景：
// - delete：d/x 是越界的新文件，平台要删掉它。修复前会顺着刚换上的链接删掉 OUTSIDE/x。
// - restore：d/f 在 HEAD 里、被改过且越界，平台要把它恢复成 HEAD 的内容。修复前 git restore 会顺着链接覆盖 OUTSIDE/f。
// 每轮之后检查 OUTSIDE 里的文件有没有被删或被改。修复后一次都不能碰到外面（撤销可以失败、任务停下，这是"失败就关"）。
// 用法：node --import tsx scripts/revert-race.ts [每个场景的轮数，默认 1000] [git.ts 路径，默认 src/runner/git.ts]
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const rounds = Number(process.argv[2] ?? 1000)
const gitModule = resolve(process.argv[3] ?? join(import.meta.dirname, '..', 'src', 'runner', 'git.ts'))
const { commitInScope } = (await import(gitModule)) as typeof import('../src/runner/git.ts')
const ROOT = join(import.meta.dirname, '..')

const scenario = async (kind: 'delete' | 'restore') => {
  const base = join(ROOT, '.eos', 'revert-race', kind)
  rmSync(base, { recursive: true, force: true })
  const main = join(base, 'main')
  const wt = join(base, 'wt')
  const outside = join(base, 'OUTSIDE')
  const stage = join(base, 'stage')
  mkdirSync(main, { recursive: true })
  mkdirSync(outside)
  mkdirSync(stage)
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' })
  writeFileSync(join(main, 'README.md'), '# demo\n')
  if (kind === 'restore') {
    mkdirSync(join(main, 'd'))
    writeFileSync(join(main, 'd', 'f'), 'head\n')
  }
  g(main, 'init', '-q', '-b', 'main')
  g(main, 'add', '-A')
  g(main, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'init')
  g(main, 'worktree', 'add', '-q', '-b', `eos/${kind}`, wt)
  const name = kind === 'delete' ? 'x' : 'f'
  const victim = join(outside, name)
  if (kind === 'restore') rmSync(join(wt, 'd'), { recursive: true })
  // 竞态进程：备用的真目录和链接放在 worktree 外面（同一个文件系统，rename 仍是原子的），worktree 里只出现 d 本身。
  // 进程先 cd /：平台撤销前的进程清理（按工作目录找）找不到它，只能靠删除和写回本身不被引走。
  const racer = spawn(process.execPath, ['-e', `
process.chdir('/')
const fs = require('fs'), path = require('path')
const [wt, outside, stage, name] = process.argv.slice(1)
const d = path.join(wt, 'd'), real = path.join(stage, 'real'), link = path.join(stage, 'link')
const fill = () => {
  try { const st = fs.lstatSync(real); if (!st.isDirectory()) fs.rmSync(real, { recursive: true, force: true }) } catch {}
  try { fs.mkdirSync(real, { recursive: true }); fs.writeFileSync(path.join(real, name), 'agent\\n') } catch {}
}
const relink = () => {
  try { if (!fs.lstatSync(link).isSymbolicLink()) fs.rmSync(link, { recursive: true, force: true }) } catch {}
  try { fs.symlinkSync(outside, link) } catch {}
}
fill()
relink()
for (;;) {
  // 平台可能在 d 不存在的瞬间自己建了 d（例如写回时重建上级目录）：清掉，再接着换。
  try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
  try { fs.renameSync(real, d) } catch {}
  try { fs.renameSync(d, real) } catch {}
  try { fs.renameSync(link, d) } catch {}
  try { fs.renameSync(d, link) } catch {}
  // 备用的真目录和链接被打乱了（例如被换走的 d 其实是平台建的目录）就修好。
  let ok = false
  try { ok = fs.readFileSync(path.join(real, name), 'utf8') === 'agent\\n' } catch {}
  if (!ok) fill()
  relink()
}`, wt, outside, stage, name], { stdio: 'ignore' })
  let touchedOutside = 0
  let refused = 0
  const samples = new Map<string, number>()
  try {
    for (let i = 0; i < rounds; i++) {
      writeFileSync(victim, 'outside\n')
      try {
        commitInScope(wt, ['src/**'], `round ${i}`, main)
      } catch (e) {
        refused++
        const first = (e as Error).message.split('\n')[0]!.replace(/round \d+/, 'round N').slice(0, 140)
        samples.set(first, (samples.get(first) ?? 0) + 1)
      }
      if (!existsSync(victim) || readFileSync(victim, 'utf8') !== 'outside\n') touchedOutside++
    }
  } finally {
    racer.kill('SIGKILL')
  }
  return { kind, rounds, touchedOutside, refused, errorSamples: Object.fromEntries([...samples].sort((a, b) => b[1] - a[1]).slice(0, 6)) }
}

const results = [await scenario('delete'), await scenario('restore')]
const report = { gitModule, results }
console.log(JSON.stringify(report, null, 2))
process.exit(results.every(r => r.touchedOutside === 0) ? 0 : 1)
