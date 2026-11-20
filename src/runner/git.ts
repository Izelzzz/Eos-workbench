// 任务的 git worktree：每个任务一个分支和工作目录，放在平台数据目录下（不放 /tmp）。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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

/** 提交 worktree 里的全部改动；没有改动就什么都不做。重复调用结果相同。 */
export const commitAll = (worktree: string, message: string): string | undefined => {
  git(worktree, ['add', '-A'])
  if (git(worktree, ['status', '--porcelain']) === '') return undefined
  git(worktree, ['-c', 'user.name=Eos', '-c', 'user.email=eos@localhost', 'commit', '-q', '--no-verify', '-m', message])
  return git(worktree, ['rev-parse', '--short', 'HEAD'])
}

export const diffStat = (w: Worktree): string => git(w.worktree, ['diff', '--stat', w.baseSha, 'HEAD'])

export const contextFor = (w: Worktree): string =>
  `工作目录是任务的 git worktree：${w.worktree}（分支 ${w.branch}）。基线提交是 ${w.baseSha.slice(0, 12)}。` +
  `平台会在开发每次回复后自动提交，查看全部改动用 \`git diff ${w.baseSha.slice(0, 12)}\`，查看提交历史用 \`git log --oneline ${w.baseSha.slice(0, 12)}..HEAD\`。`
