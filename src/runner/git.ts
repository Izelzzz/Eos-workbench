// 任务的 git worktree：每个任务一个分支和工作目录，放在平台数据目录下（不放 /tmp）。
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { matchesAny } from '../workflow/glob.ts'

/**
 * 平台自己调 git 时关掉 worktree 里能触发执行命令的配置（fsmonitor、hooks）：agent 能写 worktree，
 * 不能让平台以平台的权限替它执行命令。
 */
const SAFE = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null']

const gitRaw = (cwd: string, args: string[]): Buffer =>
  execFileSync('git', [...SAFE, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

const git = (cwd: string, args: string[]): string => gitRaw(cwd, args).toString('utf8').trim()

/** 严格按 UTF-8 解码；不是合法 UTF-8 返回 undefined（不能用替换字符当路径：会对不上真实文件）。 */
const utf8 = (b: Buffer): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    return undefined
  }
}

/** 按 \0 切开 git -z 的输出（保留原始字节）。 */
const splitNul = (b: Buffer): Buffer[] => {
  const out: Buffer[] = []
  let start = 0
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0) {
      out.push(b.subarray(start, i))
      start = i + 1
    }
  }
  if (start < b.length) out.push(b.subarray(start))
  return out
}

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
 * untracked：未跟踪的新文件或目录（目录以 / 结尾，是嵌套的 git 仓库）。
 * raw：路径不是合法 UTF-8 时的原始字节，这种改动一律算越界（path 只用来显示）。
 * dsh 的沙箱只能整体允许或禁止写 worktree，收不窄到子路径，所以越界的改动由平台在提交前撤销。
 */
export type Change = { path: string; from?: string; untracked?: boolean; raw?: Buffer }

/** 改动涉及的全部路径：改名要两边都在可写范围内才算没越界。 */
export const pathsOf = (c: Change): string[] => (c.from === undefined ? [c.path] : [c.path, c.from])

/** 这处改动是否在可写范围内。名字不是合法 UTF-8 的、嵌套的 git 仓库，一律不在。 */
export const inScope = (c: Change, writePaths: string[]): boolean =>
  c.raw === undefined && !c.path.endsWith('/') && pathsOf(c).every(p => matchesAny(writePaths, p))

const shown = (b: Buffer): string => [...b].map(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : `\\x${x.toString(16).padStart(2, '0')}`)).join('')

/**
 * 列出 worktree 里全部改动（改过的、删掉的、改名的、新加的未跟踪文件），不管有没有 git add 过。
 * 外部数据只在这里解析：`-z` 的输出是 `XY 路径\0`，改名多一段 `\0 改名前的路径`，路径不转义、按原始字节读。
 */
export const changes = (worktree: string): Change[] => {
  const fields = splitNul(gitRaw(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
  const out: Change[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const [x, y] = [String.fromCharCode(field[0]!), String.fromCharCode(field[1]!)]
    const rawPath = field.subarray(3)
    const path = utf8(rawPath)
    const untracked = x === '?' && y === '?'
    let from: string | undefined
    let rawFrom: Buffer | undefined
    // 改名和复制的下一段是改名前的路径。
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      rawFrom = fields[++i]
      from = rawFrom === undefined || rawFrom.length === 0 ? undefined : utf8(rawFrom)
    }
    const invalid = path === undefined || (rawFrom !== undefined && rawFrom.length > 0 && from === undefined)
    out.push({
      path: path ?? shown(rawPath), ...(from === undefined ? {} : { from }), ...(untracked ? { untracked } : {}),
      ...(invalid ? { raw: rawPath } : {}),
    })
  }
  return out
}

/** 按字面量（而不是通配符）传给 git 的路径：文件名里的 *、? 和 [] 不能被当成 pathspec 的通配。 */
const literal = (path: string): string => `:(literal)${path}`

const inHead = (worktree: string, path: string): boolean =>
  git(worktree, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', literal(path)]) !== ''

/** 把一条路径恢复成 HEAD 里的样子：HEAD 里有就还原（同时清掉暂存），没有就从暂存区去掉并删掉文件（目录整个删）。 */
const revert = (worktree: string, path: string): void => {
  if (!path.endsWith('/') && inHead(worktree, path)) {
    git(worktree, ['restore', '--source=HEAD', '--staged', '--worktree', '--', literal(path)])
    return
  }
  git(worktree, ['rm', '-r', '-f', '--quiet', '--cached', '--ignore-unmatch', '--', literal(path.replace(/\/$/, ''))])
  rmSync(join(worktree, path), { force: true, recursive: true })
}

/**
 * 撤销超出可写范围的改动，返回被撤销的路径（排序去重）。改名只要有一边越界就整条撤销：
 * 恢复改名前的路径、删掉改名后的路径。名字不是合法 UTF-8 的未跟踪文件按原始字节删掉；
 * 撤销不了的（已跟踪的非 UTF-8 文件名）留着，由 commitInScope 拒绝提交。重复调用结果相同。
 */
export const revertOutOfScope = (worktree: string, writePaths: string[]): string[] => {
  const reverted = new Set<string>()
  for (const change of changes(worktree)) {
    if (inScope(change, writePaths)) continue
    if (change.raw !== undefined) {
      if (change.untracked) {
        rmSync(Buffer.concat([Buffer.from(worktree + sep), change.raw]), { force: true, recursive: true })
        reverted.add(change.path)
      }
      continue
    }
    // 先恢复改名前的路径，再处理改名后的：反过来会把刚恢复的文件又删掉（HEAD 里没有改名后的路径）。
    for (const p of [...pathsOf(change)].reverse()) {
      revert(worktree, p)
      reverted.add(p)
    }
  }
  return [...reverted].sort()
}

/**
 * worktree 的 .git 必须还是 git 建 worktree 时写的那个普通文件，指向主仓库的 worktrees 目录。
 * agent 能写 worktree：它把 .git 换成自己的仓库，就能用那个仓库的配置让平台的 git 执行命令。被改过就不再执行 git。
 */
export const assertGitLink = (worktree: string, repo: string): void => {
  const file = join(worktree, '.git')
  const fail = () => {
    throw new Error(`worktree 的 .git 被改动过，平台不再在这里执行 git：${file}。请人工检查这个任务的 worktree`)
  }
  if (!existsSync(file) || !lstatSync(file).isFile()) fail()
  const target = /^gitdir: (.+?)\s*$/.exec(readFileSync(file, 'utf8'))?.[1]
  const common = resolve(repo, git(repo, ['rev-parse', '--git-common-dir']))
  if (target === undefined || !resolve(worktree, target).startsWith(join(common, 'worktrees') + sep)) fail()
}

const staged = (worktree: string): { paths: string[]; invalid: number } => {
  const parts = splitNul(gitRaw(worktree, ['diff', '--cached', '--name-only', '-z'])).filter(b => b.length > 0)
  const paths = parts.map(utf8)
  return { paths: paths.filter((p): p is string => p !== undefined), invalid: paths.filter(p => p === undefined).length }
}

/**
 * 先撤销越界的改动，再提交剩下的；没有可提交的改动就只撤销。重复调用结果相同。
 * writePaths 是角色的可写范围（worktree 内的 glob）；['**'] 表示整个 worktree 都能写。
 * 失败就关（fail closed）：撤销之后再列一遍改动、提交前再核对暂存区，还有越界就不提交，抛错让任务停下等人处理。
 * 只暂存范围内的路径（白名单），不用 add -A：撤销漏掉的东西不会被顺手提交。
 */
export const commitInScope = (worktree: string, writePaths: string[], message: string, repo?: string): { sha?: string; reverted: string[] } => {
  if (repo !== undefined) assertGitLink(worktree, repo)
  const reverted = revertOutOfScope(worktree, writePaths)
  const after = changes(worktree)
  const left = after.filter(c => !inScope(c, writePaths))
  if (left.length > 0) throw new Error(`有越界改动撤销不了，没有提交：${left.map(c => c.path).join('、')}`)
  const paths = [...new Set(after.flatMap(pathsOf))]
  if (paths.length === 0) return { reverted }
  git(worktree, ['add', '-A', '--', ...paths.map(literal)])
  const s = staged(worktree)
  const bad = s.paths.filter(p => !matchesAny(writePaths, p))
  if (bad.length > 0 || s.invalid > 0) {
    git(worktree, ['reset', '-q'])
    throw new Error(`暂存区里有越界改动，没有提交：${[...bad, ...(s.invalid > 0 ? [`${s.invalid} 个文件名不是合法 UTF-8 的文件`] : [])].join('、')}`)
  }
  if (s.paths.length === 0) return { reverted }
  git(worktree, ['-c', 'user.name=Eos', '-c', 'user.email=eos@localhost', 'commit', '-q', '--no-verify', '-m', message])
  return { sha: git(worktree, ['rev-parse', '--short', 'HEAD']), reverted }
}

export const diffStat = (w: Worktree): string => git(w.worktree, ['diff', '--stat', w.baseSha, 'HEAD'])

export const contextFor = (w: Worktree): string =>
  `工作目录是任务的 git worktree：${w.worktree}（分支 ${w.branch}）。基线提交是 ${w.baseSha.slice(0, 12)}。` +
  `平台会在开发每次回复后自动提交，查看全部改动用 \`git diff ${w.baseSha.slice(0, 12)}\`，查看提交历史用 \`git log --oneline ${w.baseSha.slice(0, 12)}..HEAD\`。`
