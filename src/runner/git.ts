// 任务的 git worktree：每个任务一个分支和工作目录，放在平台数据目录下（不放 /tmp）。
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { matchesAny } from '../workflow/glob.ts'

/**
 * 平台自己调 git 时关掉能触发执行命令的配置（fsmonitor、hooks），也不进入子模块（子模块目录里 agent 能放自己的仓库和配置）。
 * agent 能写 worktree，不能让平台以平台的权限替它执行命令。
 */
const SAFE = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false']

/** 改动很多时 git 的输出会超过默认的 1MB 缓冲区。 */
const MAX_BUFFER = 1024 * 1024 * 1024

const gitRaw = (cwd: string, args: string[], input?: Buffer): Buffer =>
  execFileSync('git', [...SAFE, ...args], { cwd, maxBuffer: MAX_BUFFER, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) })

const git = (cwd: string, args: string[]): string => gitRaw(cwd, args).toString('utf8').trim()

/** 严格按 UTF-8 解码；不是合法 UTF-8 返回 undefined（不能用替换字符当路径：会对不上真实文件）。保留开头的 BOM。 */
const utf8 = (b: Buffer): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b)
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
 * 平台在 worktree 里执行 git 时用的位置。gitDir 是主仓库里这个 worktree 的管理目录，从主仓库找出来（主仓库在 agent 沙箱之外），
 * 不读 worktree 里的 .git（agent 能改它：换成自己的仓库让平台执行它的配置，或指向别的任务的管理目录把提交落到别的分支上）。
 */
export type Loc = { worktree: string; gitDir: string }

const real = (p: string): string => realpathSync(p)

/**
 * 找出 worktree 在主仓库里的管理目录：主仓库 <common>/worktrees/ 下，gitdir 文件指回这个 worktree 的 .git 的那一个。
 * repo 和 worktree 相同（测试里直接在仓库上操作）时就是仓库自己的 git 目录。
 */
export const locate = (worktree: string, repo: string): Loc => {
  const common = resolve(repo, git(repo, ['rev-parse', '--git-common-dir']))
  if (real(repo) === real(worktree)) return { worktree, gitDir: real(resolve(repo, git(repo, ['rev-parse', '--git-dir']))) }
  const admin = join(common, 'worktrees')
  const target = join(real(worktree), '.git')
  for (const name of existsSync(admin) ? readdirSync(admin) : []) {
    const file = join(admin, name, 'gitdir')
    if (!existsSync(file)) continue
    const recorded = readFileSync(file, 'utf8').trim()
    if (recorded === target || (existsSync(dirname(recorded)) && join(real(dirname(recorded)), '.git') === target)) return { worktree, gitDir: real(join(admin, name)) }
  }
  throw new Error(`主仓库 ${repo} 里找不到 worktree ${worktree} 的登记，平台不在这里执行 git`)
}

/** 在 worktree 里执行 git：显式指定 git 目录和工作目录，不让 git 自己找（不看 worktree 里的 .git）。 */
const wgit = (loc: Loc, args: string[], input?: Buffer): Buffer =>
  gitRaw(loc.worktree, ['--git-dir', loc.gitDir, '--work-tree', loc.worktree, ...args], input)
const wgitText = (loc: Loc, args: string[]): string => wgit(loc, args).toString('utf8').trim()

/**
 * worktree 的 .git 必须还是 git 建 worktree 时写的那个普通文件，指向它自己的管理目录。平台的 git 已经不读它；
 * 被改过说明 agent 在动 git 的元数据，任务停下等人看。
 */
export const assertGitLink = (loc: Loc): void => {
  const file = join(loc.worktree, '.git')
  const fail = () => {
    throw new Error(`worktree 的 .git 被改动过，平台不再在这里执行 git：${file}。请人工检查这个任务的 worktree`)
  }
  if (!existsSync(file) || !lstatSync(file).isFile()) fail()
  const target = /^gitdir: (.+?)\s*$/.exec(readFileSync(file, 'utf8'))?.[1]
  if (target === undefined || !existsSync(resolve(loc.worktree, target)) || real(resolve(loc.worktree, target)) !== loc.gitDir) fail()
}

/**
 * worktree 里的一处改动。path 是现在的路径；from 只在 git 认出的改名里有，是改名前的路径。
 * untracked：未跟踪的新文件或目录（目录以 / 结尾，是嵌套的 git 仓库）。
 * raw：路径不是合法 UTF-8 时的原始字节，这种改动一律算越界（path 只用来显示）。
 * linkDir：指向目录的符号链接，或换掉了 HEAD 里一个目录的符号链接（含悬空的），一律算越界。
 * gitlink：HEAD 里是子模块的路径被改动（换成文件、删掉、里面放了东西），一律算越界：平台不管理子模块。
 * hidden：被新加或改过的 .gitignore 藏起来的文件（agent 自己写的忽略规则不可信），按未跟踪的新文件处理。
 * dsh 的沙箱只能整体允许或禁止写 worktree，收不窄到子路径，所以越界的改动由平台在提交前撤销。
 */
export type Change = { path: string; from?: string; untracked?: boolean; raw?: Buffer; linkDir?: boolean; gitlink?: boolean; hidden?: boolean }

/** 改动涉及的全部路径：改名要两边都在可写范围内才算没越界。 */
export const pathsOf = (c: Change): string[] => (c.from === undefined ? [c.path] : [c.path, c.from])

/** 这处改动是否在可写范围内。名字不是合法 UTF-8 的、嵌套的 git 仓库、指向目录的符号链接，一律不在。 */
export const inScope = (c: Change, writePaths: string[]): boolean =>
  c.raw === undefined && !c.linkDir && !c.gitlink && !c.path.endsWith('/') && pathsOf(c).every(p => matchesAny(writePaths, p))

const shown = (b: Buffer): string => [...b].map(x => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : `\\x${x.toString(16).padStart(2, '0')}`)).join('')

const isLink = (abs: string): boolean => {
  try {
    return lstatSync(abs).isSymbolicLink()
  } catch {
    return false
  }
}

const isDir = (abs: string): boolean => {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

/** HEAD 里的子模块路径（mode 160000）和目录路径。 */
const headShape = (loc: Loc): { gitlinks: Set<string>; dirs: Set<string> } => {
  const gitlinks = new Set<string>()
  const dirs = new Set<string>()
  for (const entry of splitNul(wgit(loc, ['ls-tree', '-r', '-t', '-z', 'HEAD']))) {
    const tab = entry.indexOf(0x09)
    if (tab < 0) continue
    const [mode, type] = entry.subarray(0, tab).toString('utf8').split(' ')
    const path = utf8(entry.subarray(tab + 1))
    if (path === undefined) continue
    if (mode === '160000') gitlinks.add(path)
    else if (type === 'tree') dirs.add(path)
  }
  return { gitlinks, dirs }
}

/**
 * 被忽略的路径里，哪些是被"不可信的"忽略规则藏起来的：规则来自新加的或改过的 .gitignore（HEAD 里没有，或和 HEAD 不同）。
 * 可信的规则（HEAD 里原样的 .gitignore、主仓库的 info/exclude、宿主机的全局配置）忽略的文件不算改动。
 */
const hiddenByAgent = (loc: Loc, ignored: string[], changed: Set<string>): string[] => {
  if (ignored.length === 0) return []
  const out = splitNul(wgit(loc, ['check-ignore', '-v', '-z', '--stdin'], Buffer.from(ignored.map(p => `${p}\0`).join(''))))
  const hidden: string[] = []
  // -v -z 的输出每条四段：规则来源、行号、规则、路径。
  for (let i = 0; i + 3 < out.length; i += 4) {
    const source = utf8(out[i]!)
    const path = utf8(out[i + 3]!)
    if (source === undefined || path === undefined) continue
    const inWorktree = !source.startsWith('/') && !source.startsWith(loc.gitDir)
    if (inWorktree && (changed.has(source) || ignored.includes(source) || wgitText(loc, ['ls-tree', '-z', '--name-only', 'HEAD', '--', literal(source)]) === '')) hidden.push(path)
  }
  return hidden
}

/**
 * 列出 worktree 里全部改动（改过的、删掉的、改名的、新加的未跟踪文件），不管有没有 git add 过；不进入子模块。
 * 外部数据只在这里解析：`-z` 的输出是 `XY 路径\0`，改名多一段 `\0 改名前的路径`，路径不转义、按原始字节读。
 */
export const changes = (loc: Loc | string): Change[] => {
  const l = typeof loc === 'string' ? locate(loc, loc) : loc
  // dirty：子模块不往里看内容（不会执行子模块里 agent 放的配置），但子模块路径本身被换掉、删掉能看到。
  const fields = splitNul(wgit(l, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--ignored=matching']))
  const shape = headShape(l)
  const out: Change[] = []
  const ignored: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!
    if (field.length < 4) continue
    const [x, y] = [String.fromCharCode(field[0]!), String.fromCharCode(field[1]!)]
    const rawPath = field.subarray(3)
    const path = utf8(rawPath)
    if (x === '!' && y === '!') {
      if (path !== undefined) ignored.push(path)
      continue
    }
    const untracked = x === '?' && y === '?'
    let from: string | undefined
    let rawFrom: Buffer | undefined
    // 改名和复制的下一段是改名前的路径。
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      rawFrom = fields[++i]
      from = rawFrom === undefined || rawFrom.length === 0 ? undefined : utf8(rawFrom)
    }
    const invalid = path === undefined || (rawFrom !== undefined && rawFrom.length > 0 && from === undefined)
    const bare = path?.replace(/\/$/, '')
    const abs = bare === undefined ? undefined : join(l.worktree, bare)
    const linkDir = abs !== undefined && isLink(abs) && (isDir(abs) || shape.dirs.has(bare!))
    const gitlink = bare !== undefined && shape.gitlinks.has(bare)
    out.push({
      path: path ?? shown(rawPath), ...(from === undefined ? {} : { from }), ...(untracked ? { untracked } : {}),
      ...(invalid ? { raw: rawPath } : {}), ...(linkDir ? { linkDir } : {}), ...(gitlink ? { gitlink } : {}),
    })
  }
  // 被 agent 自己写的忽略规则藏起来的文件，当成未跟踪的新文件。
  for (const path of hiddenByAgent(l, ignored, new Set(out.flatMap(pathsOf)))) out.push({ path, untracked: true, hidden: true })
  return out
}

/** 按字面量（而不是通配符）传给 git 的路径：文件名里的 *、? 和 [] 不能被当成 pathspec 的通配。 */
const literal = (path: string): string => `:(literal)${path}`

const inHead = (loc: Loc, path: string): boolean =>
  wgitText(loc, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', literal(path)]) !== ''

/**
 * 在核对过真实路径的目录里执行命令（Izelzzz/Eos-workbench#28）。shell 先进入目标的上级目录，用 pwd -P 确认它的
 * 真实路径在 worktree 里，再在这个目录里执行 rm / mkdir / find：进入之后操作的就是这个目录本身，别的进程之后再把路径
 * 换成指向外面的链接也引不走。核对不通过就什么都不做，抛错让提交停下（失败就关）。
 */
const VERIFIED = 'here=$(pwd -P) || exit 3; case "$here/" in "$1"/*) ;; *) exit 3;; esac; shift; exec "$@"'

export class OutsideWorktree extends Error {}

const inVerifiedDir = (worktree: string, parentRel: string, argv: string[]): void => {
  const cwd = join(worktree, parentRel)
  if (!existsSync(cwd)) return
  try {
    execFileSync('sh', ['-c', VERIFIED, 'sh', real(worktree), ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { status?: number; code?: string; stderr?: unknown }
    // 目录在核对和执行之间消失了：要删的东西已经不在，不算错。
    if (err.code === 'ENOENT') return
    if (err.status === 3) throw new OutsideWorktree(`worktree 里的目录 ${parentRel || '.'} 被换成了指向外面的链接，平台没有删除也没有提交`)
    throw new Error(`撤销时 ${argv[0]} 失败（worktree 里的文件在撤销过程中被改动），没有提交：${String(err.stderr ?? '').trim().split('\n')[0] ?? ''}`)
  }
}

const splitLast = (rel: string): { dir: string; base: string } => {
  const bare = rel.replace(/\/$/, '')
  const i = bare.lastIndexOf('/')
  return i < 0 ? { dir: '', base: bare } : { dir: bare.slice(0, i), base: bare.slice(i + 1) }
}

/** 删掉 worktree 里的一条路径（文件、目录或链接本身，不跟随链接）。 */
export const safeRemove = (worktree: string, rel: string): void => {
  const { dir, base } = splitLast(rel)
  inVerifiedDir(worktree, dir, ['rm', '-rf', '--', base])
}

const safeMkdir = (worktree: string, rel: string): void => {
  const { dir, base } = splitLast(rel)
  inVerifiedDir(worktree, dir, ['mkdir', '-p', '--', base])
}

/** 删掉名字不是合法 UTF-8 的路径：在核对过的上级目录里按 inode 找到它再删（命令行参数传不了这种名字）。 */
const safeRemoveRaw = (worktree: string, raw: Buffer): void => {
  const slash = raw.lastIndexOf(0x2f)
  const dir = slash < 0 ? '' : utf8(raw.subarray(0, slash))
  if (dir === undefined) throw new Error('文件名不是合法 UTF-8、上级目录名也不是：平台没有删除也没有提交')
  let ino: number
  try {
    ino = lstatSync(Buffer.concat([Buffer.from(worktree + sep), raw])).ino
  } catch {
    return
  }
  inVerifiedDir(worktree, dir, ['find', '.', '-mindepth', '1', '-maxdepth', '1', '-inum', String(ino), '-exec', 'rm', '-rf', '--', '{}', '+'])
}

/** 这条路径的上级目录里有没有符号链接：有的话不能顺着它删文件（会删到 worktree 外面去）。 */
const behindLink = (worktree: string, path: string): boolean => {
  const parts = path.replace(/\/$/, '').split('/').slice(0, -1)
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (lstatSync(join(worktree, ...parts.slice(0, i))).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

/** 把一条路径恢复成 HEAD 里的样子：HEAD 里有就还原（同时清掉暂存），没有就从暂存区去掉并删掉文件（目录整个删）。 */
const revert = (loc: Loc, path: string, gitlink = false): void => {
  if (gitlink) {
    // 子模块路径：清掉暂存的改动，把路径恢复成空目录（新建 worktree 时子模块就是空目录）。
    wgit(loc, ['restore', '--source=HEAD', '--staged', '--', literal(path)])
    safeRemove(loc.worktree, path)
    safeMkdir(loc.worktree, path)
    return
  }
  if (behindLink(loc.worktree, path)) {
    // 上级目录是符号链接：只清暂存，不碰文件（链接本身作为未跟踪的改动另行撤销）。
    wgit(loc, ['rm', '-r', '-f', '--quiet', '--cached', '--ignore-unmatch', '--', literal(path.replace(/\/$/, ''))])
    return
  }
  if (!path.endsWith('/') && inHead(loc, path)) {
    wgit(loc, ['restore', '--source=HEAD', '--staged', '--worktree', '--', literal(path)])
    return
  }
  wgit(loc, ['rm', '-r', '-f', '--quiet', '--cached', '--ignore-unmatch', '--', literal(path.replace(/\/$/, ''))])
  safeRemove(loc.worktree, path)
}

/**
 * 撤销超出可写范围的改动，返回被撤销的路径（排序去重）。改名只要有一边越界就整条撤销：
 * 恢复改名前的路径、删掉改名后的路径。名字不是合法 UTF-8 的未跟踪文件按原始字节删掉；
 * 先删越界的符号链接（目录换成的链接），再处理其余改动。撤销不了的留着，由 commitInScope 拒绝提交。重复调用结果相同。
 */
export const revertOutOfScope = (loc: Loc | string, writePaths: string[]): string[] => {
  const l = typeof loc === 'string' ? locate(loc, loc) : loc
  const reverted = new Set<string>()
  // 先处理指向目录的符号链接：只删链接本身（不跟随）；换掉的是已跟踪的文件就从 HEAD 恢复，免得被当成删除提交。
  for (const change of changes(l).filter(c => c.linkDir && !c.gitlink)) {
    const path = change.path.replace(/\/$/, '')
    safeRemove(l.worktree, path)
    if (!change.untracked && inHead(l, path)) wgit(l, ['restore', '--source=HEAD', '--staged', '--worktree', '--', literal(path)])
    reverted.add(path)
  }
  for (const change of changes(l)) {
    if (inScope(change, writePaths)) continue
    if (change.raw !== undefined) {
      if (change.untracked) {
        safeRemoveRaw(l.worktree, change.raw)
        reverted.add(change.path)
      }
      continue
    }
    // 先恢复改名前的路径，再处理改名后的：反过来会把刚恢复的文件又删掉（HEAD 里没有改名后的路径）。
    for (const p of [...pathsOf(change)].reverse()) {
      revert(l, p, change.gitlink === true)
      reverted.add(p)
    }
  }
  return [...reverted].sort()
}

const staged = (loc: Loc): { paths: string[]; invalid: number } => {
  const parts = splitNul(wgit(loc, ['diff', '--cached', '--name-only', '-z', '--ignore-submodules=dirty'])).filter(b => b.length > 0)
  const paths = parts.map(utf8)
  return { paths: paths.filter((p): p is string => p !== undefined), invalid: paths.filter(p => p === undefined).length }
}

/**
 * 先撤销越界的改动，再提交剩下的；没有可提交的改动就只撤销。重复调用结果相同。
 * writePaths 是角色的可写范围（worktree 内的 glob）；['**'] 表示整个 worktree 都能写。repo 是主仓库（用来找 git 目录）。
 * 失败就关（fail closed）：撤销之后再列一遍改动、提交前再核对暂存区，还有越界就不提交，抛错让任务停下等人处理。
 * 只暂存范围内的路径（白名单，路径从标准输入传给 git，不受命令行长度限制），不用 add -A：撤销漏掉的东西不会被顺手提交。
 */
export const commitInScope = (worktree: string, writePaths: string[], message: string, repo: string): { sha?: string; reverted: string[] } => {
  const loc = locate(worktree, repo)
  if (real(repo) !== real(worktree)) assertGitLink(loc)
  const reverted = revertOutOfScope(loc, writePaths)
  const after = changes(loc)
  const left = after.filter(c => !inScope(c, writePaths))
  if (left.length > 0) throw new Error(`有越界改动撤销不了，没有提交：${left.map(c => c.path).join('、')}`)
  const paths = [...new Set(after.flatMap(pathsOf))]
  if (paths.length === 0) return { reverted }
  wgit(loc, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], Buffer.from(paths.map(p => `${literal(p)}\0`).join('')))
  const s = staged(loc)
  const bad = s.paths.filter(p => !matchesAny(writePaths, p))
  if (bad.length > 0 || s.invalid > 0) {
    wgit(loc, ['reset', '-q'])
    throw new Error(`暂存区里有越界改动，没有提交：${[...bad, ...(s.invalid > 0 ? [`${s.invalid} 个文件名不是合法 UTF-8 的文件`] : [])].join('、')}`)
  }
  if (s.paths.length === 0) return { reverted }
  wgit(loc, ['-c', 'user.name=Eos', '-c', 'user.email=eos@localhost', 'commit', '-q', '--no-verify', '-m', message])
  return { sha: wgitText(loc, ['rev-parse', '--short', 'HEAD']), reverted }
}

export const diffStat = (w: Worktree): string => wgitText(locate(w.worktree, w.repo), ['diff', '--stat', w.baseSha, 'HEAD'])

export const contextFor = (w: Worktree): string =>
  `工作目录是任务的 git worktree：${w.worktree}（分支 ${w.branch}）。基线提交是 ${w.baseSha.slice(0, 12)}。` +
  `平台会在开发每次回复后自动提交，查看全部改动用 \`git diff ${w.baseSha.slice(0, 12)}\`，查看提交历史用 \`git log --oneline ${w.baseSha.slice(0, 12)}..HEAD\`。`
