// 任务的 git worktree：每个任务一个分支和工作目录，放在平台数据目录下（不放 /tmp）。
import { execFileSync } from 'node:child_process'
import { withoutCaps } from './check-user.ts'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { type FileChange, type FileDiff, hunks, MAX_FILES, type TaskChanges, truncate } from './changes.ts'
import { matchesAny } from '../workflow/glob.ts'

/**
 * 平台自己调 git 时关掉能触发执行命令的配置（fsmonitor、hooks），也不进入子模块（子模块目录里 agent 能放自己的仓库和配置）。
 * agent 能写 worktree，不能让平台以平台的权限替它执行命令。
 */
export const SAFE = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false']

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

/** 在本机仓库的 HEAD 上建任务的 worktree。 */
export const createWorktree = (repoPath: string, dataDir: string, taskId: string): Worktree => {
  const repo = git(resolve(repoPath), ['rev-parse', '--show-toplevel'])
  return addWorktree(repo, git(repo, ['rev-parse', 'HEAD']), dataDir, taskId)
}

/** 在 repo（工作仓库或 bare 仓库，例如远程仓库的镜像）的 baseSha 上建任务的分支和 worktree。重复调用不会重建。 */
export const addWorktree = (repo: string, baseSha: string, dataDir: string, taskId: string): Worktree => {
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
const wgit = (loc: Loc, args: string[], input?: Buffer): Buffer => gitRaw(loc.worktree, ['--git-dir', loc.gitDir, '--work-tree', loc.worktree, ...args], input)
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
export const inScope = (c: Change, writePaths: string[]): boolean => c.raw === undefined && !c.linkDir && !c.gitlink && !c.path.endsWith('/') && pathsOf(c).every(p => matchesAny(writePaths, p))

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
      path: path ?? shown(rawPath),
      ...(from === undefined ? {} : { from }),
      ...(untracked ? { untracked } : {}),
      ...(invalid ? { raw: rawPath } : {}),
      ...(linkDir ? { linkDir } : {}),
      ...(gitlink ? { gitlink } : {}),
    })
  }
  // 被 agent 自己写的忽略规则藏起来的文件，当成未跟踪的新文件。
  for (const path of hiddenByAgent(l, ignored, new Set(out.flatMap(pathsOf)))) out.push({ path, untracked: true, hidden: true })
  return out
}

/** 按字面量（而不是通配符）传给 git 的路径：文件名里的 *、? 和 [] 不能被当成 pathspec 的通配。 */
const literal = (path: string): string => `:(literal)${path}`

const inHead = (loc: Loc, path: string): boolean => wgitText(loc, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', literal(path)]) !== ''

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
    // 处理的是 agent 写过的目录：不带平台切换用户的能力运行（部署镜像里，见 check-user.ts）。
    const [cmd, ...args] = withoutCaps(['sh', '-c', VERIFIED, 'sh', real(worktree), ...argv])
    execFileSync(cmd!, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e as { status?: number; code?: string; stderr?: unknown }
    // 目录在核对和执行之间消失了：要删的东西已经不在，不算错。目录还在时的 ENOENT 是程序（sh、setpriv）找不到，要报错。
    if (err.code === 'ENOENT' && !existsSync(cwd)) return
    if (err.status === 3) throw new OutsideWorktree(`worktree 里的目录 ${parentRel || '.'} 被换成了指向外面的链接，平台没有删除也没有提交`)
    throw new Error(
      `撤销时 ${argv[0]} 失败（worktree 里的文件在撤销过程中被改动），没有提交：${
        String(err.stderr ?? '')
          .trim()
          .split('\n')[0] ?? ''
      }`,
    )
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

/**
 * 在核对过的上级目录里，把一个文件恢复成 HEAD 里的内容（写回也不能被换上的链接引到外面，Izelzzz/Eos-workbench#28）：
 * 先写到同一目录里的临时文件，再删掉目标、用 mv -T 换上（目标在这之间又变成目录时 mv 失败，不会写进去）。
 */
const RESTORE = [
  'set -e',
  'gd=$1; mode=$2; sha=$3; base=$4; tmp=$5',
  'case "$mode" in',
  '  120000) target=$(git --git-dir="$gd" cat-file blob "$sha"); ln -s -- "$target" "$tmp" ;;',
  '  100644|100755) git --git-dir="$gd" cat-file blob "$sha" > "$tmp"; if [ "$mode" = 100755 ]; then chmod 755 "$tmp"; else chmod 644 "$tmp"; fi ;;',
  '  *) exit 4 ;;',
  'esac',
  'rm -rf -- "$base"',
  'mv -fT -- "$tmp" "$base"',
].join('\n')

const headEntry = (loc: Loc, path: string): { mode: string; sha: string } | undefined => {
  const entry = splitNul(wgit(loc, ['ls-tree', '-z', 'HEAD', '--', literal(path)]))[0]
  if (entry === undefined) return undefined
  const [mode, , sha] = entry.subarray(0, entry.indexOf(0x09)).toString('utf8').split(' ')
  return mode === undefined || sha === undefined ? undefined : { mode, sha }
}

/** 把已跟踪的一条路径恢复成 HEAD 里的样子：暂存区用 git 恢复（只改索引），文件在核对过的目录里写回。 */
const safeRestore = (loc: Loc, path: string): void => {
  wgit(loc, ['restore', '--source=HEAD', '--staged', '--', literal(path)])
  const entry = headEntry(loc, path)
  if (entry === undefined) return
  const { dir, base } = splitLast(path)
  // 上级目录被删掉了：一层一层在核对过的目录里重建。
  const parts = dir === '' ? [] : dir.split('/')
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/')
    if (!existsSync(join(loc.worktree, prefix))) safeMkdir(loc.worktree, prefix)
  }
  const tmp = `.eos-restore-${process.pid}-${Date.now().toString(36)}`
  inVerifiedDir(loc.worktree, dir, ['sh', '-c', RESTORE, 'sh', loc.gitDir, entry.mode, entry.sha, base, tmp])
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
    safeRestore(loc, path)
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
    if (!change.untracked && inHead(l, path)) safeRestore(l, path)
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

const STATUS: Record<string, FileChange['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'modified' }

/** 平台读 diff 时的公共参数：不用外部 diff 驱动和 textconv（它们会按 worktree 里的 .gitattributes 执行命令）。 */
const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M']

/**
 * 任务分支相对基线的改动，按文件（不含 diff 内容）。head 不给时解析当前 HEAD，之后的 git 调用都用这个提交，
 * 文件列表和增删行数来自同一个提交。外部数据只在这里解析：name-status 和 numstat 的 -z 输出（路径不转义）。
 * 路径不是合法 UTF-8 的文件跳过（平台不会提交这种文件）；改名前的路径不合法时当作新增。
 */
export const committedChanges = (w: Worktree, head?: string): TaskChanges => {
  const loc = locate(w.worktree, w.repo)
  // 以任务分支这个 ref 为准，不看 worktree 的 HEAD：agent 能在 worktree 里切到别的提交。
  const at = head ?? wgitText(loc, ['rev-parse', '--verify', `refs/heads/${w.branch}^{commit}`])
  const diff = (args: string[]) => wgit(loc, [...diffArgs, ...args, w.baseSha, at])
  const counts = new Map<string, { add: number; del: number; binary: boolean }>()
  const num = splitNul(diff(['--numstat', '-z']))
  for (let i = 0; i < num.length; i++) {
    // 一段是「增\t删\t路径」；改名时路径为空，后面跟两段：改名前、改名后。路径里可能有 tab，只按前两个 tab 切。
    const f = num[i]!
    const t1 = f.indexOf(9)
    const t2 = f.indexOf(9, t1 + 1)
    const [add, del, rest] = [f.subarray(0, t1).toString('utf8'), f.subarray(t1 + 1, t2).toString('utf8'), f.subarray(t2 + 1)]
    const path = rest.length === 0 ? ((i += 2), utf8(num[i]!)) : utf8(rest)
    if (path !== undefined) counts.set(path, { add: Number(add) || 0, del: Number(del) || 0, binary: add === '-' })
  }
  const files: FileChange[] = []
  const names = splitNul(diff(['--name-status', '-z']))
  for (let i = 0; i < names.length; i++) {
    const code = names[i]!.toString('utf8')[0]!
    const from = code === 'R' || code === 'C' ? utf8(names[++i]!) : undefined
    const path = utf8(names[++i]!)
    if (path === undefined) continue
    const renamed = code === 'R' && from !== undefined
    const status = renamed ? 'renamed' : code === 'R' || code === 'C' ? 'added' : (STATUS[code] ?? 'modified')
    files.push({ path, ...(renamed ? { from } : {}), status, ...(counts.get(path) ?? { add: 0, del: 0, binary: false }) })
  }
  return { base: w.baseSha, head: at, files: files.slice(0, MAX_FILES), omitted: Math.max(0, files.length - MAX_FILES) }
}

/**
 * head 是不是任务自己的提交：在基线和任务分支之间（基线是 head 的祖先，head 是任务分支的祖先）。
 * 取单个文件的 diff 前核对，不让请求读仓库里别的提交（包括基线之前的历史）。
 */
export const onBranch = (w: Worktree, head: string): boolean => {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) return false
  const loc = locate(w.worktree, w.repo)
  try {
    wgit(loc, ['merge-base', '--is-ancestor', w.baseSha, head])
    wgit(loc, ['merge-base', '--is-ancestor', head, `refs/heads/${w.branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * 推送前核对任务分支：定下分支现在指向的提交（推送只推这个提交），基线必须是它的祖先，
 * 基线之后的每一个提交（合并提交对每个父提交分别算）改到的路径都要在 writePaths 里，改名两边都算。
 * 名字不是合法 UTF-8 的一律算越界（显示成转义后的样子）。
 * 平台提交前会撤销越界改动，但 agent 能在 worktree 里自己提交、移动分支：只看最终的树不够（先加后删的文件照样在历史里）。
 */
export const scopeOfBranch = (w: Worktree, writePaths: string[]): { sha: string; outside: string[] } | { error: string } => {
  const loc = locate(w.worktree, w.repo)
  const sha = wgitText(loc, ['rev-parse', '--verify', `refs/heads/${w.branch}^{commit}`])
  try {
    wgit(loc, ['merge-base', '--is-ancestor', w.baseSha, sha])
  } catch {
    return { error: `任务分支 ${w.branch} 已经不在基线 ${w.baseSha.slice(0, 12)} 之后（分支被移到了别的历史上），没有推送；请人工检查这个任务的分支` }
  }
  const out = splitNul(wgit(loc, ['log', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-merges=separate', '--name-only', '-z', '--format=', `${w.baseSha}..${sha}`]))
  const outside = new Set<string>()
  for (const raw of out) {
    const field = raw.subarray(raw[0] === 0x0a ? 1 : 0)
    if (field.length === 0) continue
    const path = utf8(field)
    if (path === undefined) outside.add(shown(field))
    else if (!matchesAny(writePaths, path)) outside.add(path)
  }
  return { sha, outside: [...outside] }
}

/** 单个文件的 diff 最多读这么多字节：超过的部分 git 输出了也不读进内存（页面本来也只显示前面一部分）。 */
export const MAX_DIFF_BYTES = 8 * 1024 * 1024

/** 带输出上限的 git 调用：超过上限时返回已经读到的部分，不报错。 */
const wgitCapped = (loc: Loc, args: string[], max: number): { out: Buffer; capped: boolean } => {
  try {
    return {
      out: execFileSync('git', [...SAFE, '--git-dir', loc.gitDir, '--work-tree', loc.worktree, ...args], { cwd: loc.worktree, maxBuffer: max, stdio: ['ignore', 'pipe', 'pipe'] }),
      capped: false,
    }
  } catch (e) {
    const stdout = (e as { stdout?: unknown }).stdout
    if ((e as NodeJS.ErrnoException).code === 'ENOBUFS' && Buffer.isBuffer(stdout)) return { out: stdout, capped: true }
    throw e
  }
}

/** 一个文件在 head 时相对基线的 diff。文件不在改动列表里时返回 undefined。 */
export const fileDiff = (w: Worktree, head: string, path: string): FileDiff | undefined => {
  const f = committedChanges(w, head).files.find(x => x.path === path)
  if (f === undefined) return undefined
  if (f.binary) return { diff: '' }
  const loc = locate(w.worktree, w.repo)
  const { out, capped } = wgitCapped(loc, [...diffArgs, w.baseSha, head, '--', ...(f.from === undefined ? [] : [literal(f.from)]), literal(f.path)], MAX_DIFF_BYTES)
  const d = truncate(hunks(out.toString('utf8')))
  return capped ? { diff: d.diff, truncated: { bytes: MAX_DIFF_BYTES } } : d
}
