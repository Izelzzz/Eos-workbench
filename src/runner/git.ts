// 任务的 git worktree：每个任务一个分支和工作目录，放在平台数据目录下（不放 /tmp）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { matchesAny } from '../workflow/glob.ts'

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export type Worktree = { repo: string; worktree: string; branch: string; baseSha: string }

export const createWorktree = (repoPath: string, dataDir: string, taskId: string): Worktree => {
  const repo = git(resolve(repoPath), ['rev-parse', '--show-toplevel'])
  const baseSha = git(repo, ['rev-parse', 'HEAD'])
  const branch = `eos/${taskId}`
  const worktree = join(resolve(dataDir), 'worktrees', taskId)
  if (!existsSync(worktree)) {
    mkdirSync(dirname(worktree), { recursive: true })
    git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, baseSha])
  }
  return { repo, worktree, branch, baseSha }
}

/**
 * worktree 里的一处改动。path 是现在的路径；from 只在 git 认出的改名里有，是改名前的路径。
 * dsh 的沙箱只能整体允许或禁止写 worktree，收不窄到子路径，所以越界的改动由平台在提交前撤销。
 */
export type Change = { path: string; from?: string }

/** 改动涉及的全部路径：改名要两边都在可写范围内才算没越界。 */
export const pathsOf = (c: Change): string[] => (c.from === undefined ? [c.path] : [c.path, c.from])

/**
 * 列出 worktree 里全部改动（改过的、删掉的、改名的、新加的未跟踪文件），不管有没有 git add 过。
 * 外部数据只在这里解析：`-z` 的输出是 `XY 路径\0`，改名多一段 `\0 改名前的路径`，路径不转义。
 */
export const changes = (worktree: string): Change[] => {
  const raw = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const fields = raw.split('\0')
  const out: Change[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const [x, y] = [field[0]!, field[1]!]
    const path = field.slice(3)
    // 改名和复制的下一段是改名前的路径。
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const from = fields[++i]
      out.push({ path, ...(from === undefined || from === '' ? {} : { from }) })
    } else out.push({ path })
  }
  return out
}

/** 按字面量（而不是通配符）传给 git 的路径：文件名里的 *、? 和 [] 不能被当成 pathspec 的通配。 */
const literal = (path: string): string => `:(literal)${path}`

const inHead = (worktree: string, path: string): boolean =>
  git(worktree, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', literal(path)]) !== ''

/** 把一条路径恢复成 HEAD 里的样子：HEAD 里有就还原（同时清掉暂存），没有就从暂存区去掉并删掉文件。 */
const revert = (worktree: string, path: string): void => {
  if (inHead(worktree, path)) {
    git(worktree, ['restore', '--source=HEAD', '--staged', '--worktree', '--', literal(path)])
    return
  }
  git(worktree, ['rm', '-f', '--quiet', '--cached', '--ignore-unmatch', '--', literal(path)])
  rmSync(join(worktree, path), { force: true })
}

/**
 * 撤销超出可写范围的改动，返回被撤销的路径（排序去重）。改名只要有一边越界就整条撤销：
 * 恢复改名前的路径、删掉改名后的路径。重复调用结果相同。
 */
export const revertOutOfScope = (worktree: string, writePaths: string[]): string[] => {
  const reverted = new Set<string>()
  for (const change of changes(worktree)) {
    const paths = pathsOf(change)
    if (paths.every(p => matchesAny(writePaths, p))) continue
    // 先恢复改名前的路径，再处理改名后的：反过来会把刚恢复的文件又删掉（HEAD 里没有改名后的路径）。
    for (const p of [...paths].reverse()) {
      revert(worktree, p)
      reverted.add(p)
    }
  }
  return [...reverted].sort()
}

/**
 * 先撤销越界的改动，再提交剩下的；没有可提交的改动就只撤销。重复调用结果相同。
 * writePaths 是角色的可写范围（worktree 内的 glob）；['**'] 表示整个 worktree 都能写。
 */
export const commitInScope = (worktree: string, writePaths: string[], message: string): { sha?: string; reverted: string[] } => {
  const reverted = revertOutOfScope(worktree, writePaths)
  git(worktree, ['add', '-A'])
  if (git(worktree, ['status', '--porcelain']) === '') return { reverted }
  git(worktree, ['-c', 'user.name=Eos', '-c', 'user.email=eos@localhost', 'commit', '-q', '--no-verify', '-m', message])
  return { sha: git(worktree, ['rev-parse', '--short', 'HEAD']), reverted }
}

export const diffStat = (w: Worktree): string => git(w.worktree, ['diff', '--stat', w.baseSha, 'HEAD'])

export const contextFor = (w: Worktree): string =>
  `工作目录是任务的 git worktree：${w.worktree}（分支 ${w.branch}）。基线提交是 ${w.baseSha.slice(0, 12)}。` +
  `平台会在开发每次回复后自动提交，查看全部改动用 \`git diff ${w.baseSha.slice(0, 12)}\`，查看提交历史用 \`git log --oneline ${w.baseSha.slice(0, 12)}..HEAD\`。`
