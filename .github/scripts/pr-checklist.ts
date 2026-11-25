// 检查 PR 有没有走完 CLAUDE.md 自检里的流程（只查形式）：
//   - 描述里有「能用证据证明的」「证明不了的」两节，且不是空的（自检第 7 条）
//   - 改动碰到 .github/e2e-paths.txt 里「需要」的路径时，描述里有「端到端验证」一节（自检第 3 条）：
//     写了 docs/e2e/ 下的证据路径的，路径必须在这个 PR 里新增或修改过；
//     写了「不需要，理由……」的，通过但给出醒目的提示；
//     证据里有 E2E 报告（report.json，scripts/e2e.ts 写的）时，核对证据对得上 PR 的最终代码：
//     报告记的提交在 PR 的历史里，这个 PR 改过的「需要」的文件在那个提交和 PR 最新提交上一样，跑的时候也没有没提交的改动。
//     不一样时报错；描述里有非空的「证据之后的改动」一节写了理由时，改成要人确认的提示
// 只能证明「有这几节、证据文件存在、证据的提交对得上」，证明不了 E2E 真的覆盖了这次改动。
//
// 用法（在 PR 的合并提交上）：PR_BODY="..." node <脚本>
// 改动列表取 HEAD^1..HEAD，即 actions/checkout 检出的合并提交相对 base 的改动。
// 规则文件取脚本旁边的 ../e2e-paths.txt。工作流从 base（HEAD^1）取出脚本和规则来跑，
// 这样 PR 不能靠改脚本或规则放宽对自己的检查；改动要等合并后才对后面的 PR 生效。

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Rule = { need: boolean; pattern: string; regex: RegExp }

export function parseRules(text: string): Rule[] {
  const rules: Rule[] = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const m = /^(需要|不需要)\s+(\S+)$/.exec(line)
    if (!m) throw new Error(`e2e-paths.txt 第 ${i + 1} 行看不懂：${line}`)
    rules.push({ need: m[1] === '需要', pattern: m[2]!, regex: globToRegex(m[2]!) })
  })
  return rules
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      // 「**/」匹配零个或多个目录，末尾的「**」匹配剩下的一切
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i += 1
      }
    } else if (c === '*') re += '[^/]*'
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** 第一条匹配到的规则算数；都不匹配时默认需要。 */
export function needsE2E(path: string, rules: Rule[]): boolean {
  return rules.find(r => r.regex.test(path))?.need ?? true
}

/**
 * 去掉 HTML 注释，尽量和 GitHub 的渲染一致：
 * - 代码块里和行内代码（反引号）里的 <!-- 是普通文字，不算注释；
 * - 注释到它后面第一个 --> 为止，可以跨行；<!--> 和 <!---> 是空注释；
 * - <!-- 在行首（最多 3 个空格缩进）是 HTML 块：块里不认行内代码，没有 --> 就把后面全部藏起来；
 * - <!-- 在行中间是行内注释：不能跨过空行，后面没有 --> 就按普通文字显示。
 * 逐个扫描而不是用一次正则替换：嵌套的注释不会留下藏起来的半截。
 */
export function stripHtmlComments(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  // 跨行注释：前面的行开始、还没遇到 -->；block 表示它在 HTML 块里
  let open: { block: boolean } | null = null
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n]!
    let block = false
    if (open) {
      const end = line.indexOf('-->')
      if (end === -1) continue
      // HTML 块到 --> 所在的行结束，这一行剩下的部分还在块里
      block = open.block
      open = null
      line = line.slice(end + 3)
    } else {
      const marker = /^\s*(```|~~~)/.exec(line)?.[1]
      if (marker && (fence === null || fence === marker)) fence = fence === null ? marker : null
      if (fence !== null || marker) {
        out.push(line)
        continue
      }
      block = /^ {0,3}<!--/.test(line)
    }
    const r = stripLine(line, block, () => lines.slice(n + 1))
    out.push(r.text)
    if (r.open === 'rest') break
    if (r.open !== 'no') open = { block: r.open === 'block' }
  }
  return out.join('\n')
}

/**
 * 去掉一行里的注释。block：这一行在 HTML 块里（不认行内代码）。following：后面的行，
 * 只在注释没在本行闭合时才取，用来判断它会不会在后面闭合。
 */
function stripLine(line: string, block: boolean, following: () => string[]): { text: string; open: 'no' | 'block' | 'inline' | 'rest' } {
  let out = ''
  let i = 0
  for (;;) {
    const start = findOpen(line, i, block ? null : out)
    if (start === -1) return { text: out + line.slice(i), open: 'no' }
    out += line.slice(i, start)
    const after = line.slice(start + 4)
    // <!--> 和 <!---> 是空注释
    const quick = after.startsWith('>') ? 1 : after.startsWith('->') ? 2 : 0
    if (quick) {
      i = start + 4 + quick
      continue
    }
    const end = line.indexOf('-->', start + 4)
    if (end !== -1) {
      i = end + 3
      continue
    }
    const atLineStart = /^ {0,3}$/.test(line.slice(0, start))
    if (block || atLineStart) {
      // HTML 块：到 --> 所在的行为止，没有就到全文末尾
      return { text: out, open: following().some(l => l.includes('-->')) ? 'block' : 'rest' }
    }
    // 行内注释不能跨过空行
    const rest = following()
    const blank = rest.findIndex(l => l.trim() === '')
    if ((blank === -1 ? rest : rest.slice(0, blank)).some(l => l.includes('-->'))) return { text: out, open: 'inline' }
    return { text: out + line.slice(start), open: 'no' }
  }
}

/**
 * 从 from 开始找注释的开头。kept 是这一行里已经保留下来的文字（不含去掉的注释），用来判断 <!-- 是不是在
 * 行内代码（反引号）里；为 null 时（HTML 块里）不认行内代码。
 */
function findOpen(line: string, from: number, kept: string | null): number {
  for (let at = line.indexOf('<!--', from); at !== -1; at = line.indexOf('<!--', at + 1)) {
    if (kept === null) return at
    const ticks = ((kept + line.slice(from, at)).match(/`/g) ?? []).length
    if (ticks % 2 === 0) return at
  }
  return -1
}

/** 按标题切分描述。代码块里的「#」不算标题，HTML 注释不算内容。 */
export function sections(body: string): { title: string; content: string }[] {
  const out: { title: string; level: number; open: boolean; lines: string[] }[] = []
  // 代码块只由开始时的那种标记（``` 或 ~~~）结束
  let fence: string | null = null
  for (const line of stripHtmlComments(body).split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1]
    if (marker && (fence === null || fence === marker)) fence = fence === null ? marker : null
    const h = fence !== null || marker ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      // 同级或更高级的标题结束前面的节；更低级的标题（连同标题行）算在外层节的内容里
      const level = h[1]!.length
      for (const s of out) if (s.open && s.level >= level) s.open = false
      for (const s of out) if (s.open) s.lines.push(line)
      out.push({ title: h[2]!, level, open: true, lines: [] })
      continue
    }
    for (const s of out) if (s.open) s.lines.push(line)
  }
  return out.map(s => ({ title: s.title, content: s.lines.join('\n').trim() }))
}

/** 决定 CI 查什么、放行什么的文件。PR 改它们就能放宽自己的检查，所以要醒目地提示。 */
export function isGuardFile(path: string): boolean {
  return (
    path === '.gitleaksignore' ||
    path === '.gitleaks.toml' ||
    path === '.github/e2e-paths.txt' ||
    path.startsWith('.github/workflows/') ||
    path.startsWith('.github/scripts/') ||
    path.startsWith('.github/lint/') ||
    path.startsWith('.github/codeql/')
  )
}

export type Result = { errors: string[]; warnings: string[]; notes: string[] }

/** 这个 PR 改动的一个文件。删掉的文件算「改动」（要不要 E2E），但不能当证据。 */
export type Change = { path: string; deleted: boolean }

/** E2E 报告里核对证据用的几项（scripts/e2e.ts 写的 report.json），在边界按格式校验过 */
export type Report = { commit?: string; commitAtEnd?: string; uncommitted?: string[] }

/** 外部数据（PR 里的文件内容）在这里解析成 Report；格式不对返回 undefined */
export function parseReport(text: string): Report | undefined {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const str = (x: unknown) => x === undefined || typeof x === 'string'
  if (!str(o.commit) || !str(o.commitAtEnd)) return undefined
  if (o.uncommitted !== undefined && !(Array.isArray(o.uncommitted) && o.uncommitted.every(x => typeof x === 'string'))) return undefined
  return {
    ...(o.commit === undefined ? {} : { commit: o.commit as string }),
    ...(o.commitAtEnd === undefined ? {} : { commitAtEnd: o.commitAtEnd as string }),
    ...(o.uncommitted === undefined ? {} : { uncommitted: o.uncommitted as string[] }),
  }
}

/** 核对证据要用的仓库操作；check() 本身不碰 git，测试里换成桩。 */
export type Repo = {
  /** 读出 PR 里的一份报告（普通文件，不跟符号链接）；读不到或格式不对返回 undefined */
  report: (path: string) => Report | undefined
  /** 提交在 PR 的历史里（是 PR 最新提交的祖先或它本身） */
  inHistory: (commit: string) => boolean
  /** 从这个提交到 PR 最新提交，内容变过的文件 */
  changedSince: (commit: string) => string[]
  /** PR 对这个文件的改动从这个提交以来没变：把 base 带来的变化补到那个提交的版本上，等于 PR 最新提交的版本 */
  samePrChange: (commit: string, path: string) => boolean
}

/**
 * 证据对得上最终代码：报告的提交在历史里；需要真实模型的文件里，PR 改过的和这个提交之后变过的，PR 自己的改动都没再变；
 * 跑的时候没有没提交的改动、提交也没变。对不上时报错；描述里有「证据之后的改动」一节写了理由时改成要人确认的提示。
 */
function freshness(r: Result, reportPaths: string[], needed: string[], isReal: (p: string) => boolean, repo: Repo, reason: string | undefined): void {
  if (reportPaths.length === 0) {
    r.warnings.push('证据里没有带提交记录的 E2E 报告（目前只有 scripts/e2e.ts 写的 report.json 带），核对不了证据对应哪个提交：请独立审查人工核对证据对得上最终代码')
    return
  }
  for (const path of reportPaths) {
    const report = repo.report(path)
    if (report === undefined) {
      r.errors.push(`证据 ${path} 读不出来，或者不是 E2E 报告的格式`)
      continue
    }
    if (report.commit === undefined || report.commit === '') {
      r.warnings.push(`证据 ${path} 没有记下跑的是哪个提交（只有 scripts/e2e.ts 的报告记），核对不了证据对得上最终代码：请独立审查人工核对`)
      continue
    }
    const commit = report.commit
    const short = commit.slice(0, 12)
    const problems: string[] = []
    if (!repo.inHistory(commit)) {
      problems.push(`报告记的提交 ${short} 不在这个 PR 的历史里（分支 rebase 或强推过？）`)
    } else {
      const candidates = [...new Set([...needed, ...repo.changedSince(commit).filter(isReal)])]
      const changedAfter = candidates.filter(p => !repo.samePrChange(commit, p))
      if (changedAfter.length > 0) problems.push(`这些文件在 ${short} 之后又改过：${changedAfter.join('、')}`)
    }
    const dirty = (report.uncommitted ?? []).filter(isReal)
    if (dirty.length > 0) problems.push(`跑的时候这些文件有没提交的改动：${dirty.join('、')}`)
    if (report.commitAtEnd !== undefined && report.commitAtEnd !== commit) problems.push(`跑的过程中提交变了（${short} → ${report.commitAtEnd.slice(0, 12)}）`)
    if (problems.length === 0) {
      r.notes.push(`证据 ${path} 自称跑的提交 ${short} 对得上最终代码（报告是 PR 里的文件，提交号是自报的，没有签名）`)
      continue
    }
    if (reason === undefined) {
      r.errors.push(`证据 ${path} 对不上最终代码：${problems.join('；')}。重跑 E2E，或者在描述里加「证据之后的改动」一节写明为什么不用重跑（由用户批准）`)
    } else {
      r.warnings.push(`证据 ${path} 对不上最终代码：${problems.join('；')}。描述里写的理由由独立审查核实、在合并卡片上由用户批准：${reason}`)
    }
  }
}

export function check(input: { body: string; changed: Change[]; rules: Rule[]; repo?: Repo }): Result {
  const r: Result = { errors: [], warnings: [], notes: [] }
  const all = sections(input.body)
  const find = (pred: (t: string) => boolean) => all.find(s => pred(s.title))

  const required: [string, (t: string) => boolean][] = [
    ['能用证据证明的', t => /^(能用证据证明的|能证明的)/.test(t)],
    ['证明不了的', t => t.startsWith('证明不了的')],
  ]
  for (const [name, pred] of required) {
    const s = find(pred)
    if (!s) r.errors.push(`描述里缺少「${name}」一节（CLAUDE.md 自检第 7 条）`)
    else if (s.content === '') r.errors.push(`「${s.title}」一节是空的`)
  }

  const paths = input.changed.map(c => c.path)
  const present = input.changed.filter(c => !c.deleted).map(c => c.path)
  const guards = paths.filter(isGuardFile)
  if (guards.length > 0) {
    r.warnings.push(`这个 PR 改了检查规则或允许清单（${guards.join('、')}）。放宽规则要人批：独立审查核实，合并卡片上单独列出`)
  }

  const needed = paths.filter(p => needsE2E(p, input.rules))
  if (needed.length === 0) {
    r.notes.push('改动没有碰到需要 E2E 的路径（.github/e2e-paths.txt），不要求「端到端验证」一节')
    return r
  }
  r.notes.push(`需要 E2E 的改动：${needed.slice(0, 10).join('、')}${needed.length > 10 ? ` 等 ${needed.length} 个文件` : ''}`)

  const e2e = find(t => t.startsWith('端到端验证'))
  if (!e2e || e2e.content === '') {
    r.errors.push('改动碰到了需要 E2E 的路径，描述里要有非空的「端到端验证」一节：写 docs/e2e/ 下的证据路径，或写「不需要，理由是……」（CLAUDE.md 自检第 3 条）')
    return r
  }
  // 路径到空白或标点为止；* 不当通配，截到它前面的目录，按目录匹配。
  // 证据文件名可能是中文，所以路径后面紧跟的中文字会被当成路径的一部分：路径后面要留空格或标点。
  // 只写目录时，这个目录下有任何新增或修改的文件就算数。
  const evidence = [...e2e.content.matchAll(/docs\/e2e\/[^\s`'"<>()（）[\]，,。；;：:、*|]+/g)].map(m => m[0].replace(/[.)]+$/, ''))
  if (evidence.length > 0) {
    // 报告：写的证据（目录或文件）所在目录里、这个 PR 新增或修改的 report.json
    const reportDirs = new Set<string>()
    for (const p of new Set(evidence)) {
      const dir = p.endsWith('/') ? p : `${p}/`
      const files = present.filter(c => c === p || c.startsWith(dir))
      if (files.length === 0) r.errors.push(`「端到端验证」写的证据 ${p} 不在这个 PR 新增或修改的文件里`)
      for (const f of files) reportDirs.add(f.slice(0, f.lastIndexOf('/') + 1))
    }
    const reports = present.filter(c => c.endsWith('/report.json') && reportDirs.has(c.slice(0, c.lastIndexOf('/') + 1)))
    if (input.repo !== undefined) {
      const after = find(t => t.startsWith('证据之后的改动'))
      const isReal = (p: string) => needsE2E(p, input.rules)
      freshness(r, reports, needed, isReal, input.repo, after === undefined || after.content === '' ? undefined : after.content.replace(/\s+/g, ' '))
    }
    return r
  }
  // 豁免：这一节以「不需要」开头，后面跟理由（可以换行写）
  if (/^不需要[\s，,：:。.]*\S{2,}/.test(e2e.content)) {
    r.warnings.push(`这个 PR 豁免了 E2E，理由由独立审查核实、在合并卡片上由用户批准：${e2e.content.replace(/\s+/g, ' ')}`)
    return r
  }
  r.errors.push('「端到端验证」一节既没有 docs/e2e/ 下的证据路径，也没有写「不需要，理由是……」')
  return r
}

/** 解析 `git diff --name-status -z` 的输出：状态和路径用 NUL 分隔，路径不加引号、不转义（中文文件名原样）。 */
export function parseNameStatusZ(out: string): Change[] {
  const parts = out.split('\0').filter(p => p !== '')
  const changes: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ path: parts[i + 1]!, deleted: parts[i] === 'D' })
  return changes
}

/** 报告最大多少字节：比这大的不读 */
const MAX_REPORT = 1 << 20

/**
 * 用 git 实现 Repo。cwd 是检出的合并提交（HEAD），head 是 PR 的最新提交，base 是合并提交的第一个父提交。
 * 文件一律从 git 对象读，不读工作区（PR 里的文件可能是符号链接）。核对证据要完整的历史（工作流用 fetch-depth: 0）。
 */
export function gitRepo(cwd: string, head: string): Repo {
  const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * MAX_REPORT })
  const tryGit = (...a: string[]) => {
    try {
      return git(...a)
    } catch {
      return undefined
    }
  }
  const isCommit = (c: string) => /^[0-9a-f]{40}$/.test(c)
  const base = () => git('rev-parse', 'HEAD^1').trim()
  const blob = (rev: string, path: string) => tryGit('rev-parse', '--verify', '-q', `${rev}:${path}`)?.trim()
  const content = (rev: string, path: string) => (blob(rev, path) === undefined ? undefined : tryGit('cat-file', 'blob', `${rev}:${path}`))
  return {
    report: path => {
      // 只认普通文件（100644 或 100755），不认符号链接；大小有上限
      const entry = tryGit('ls-tree', '-l', 'HEAD', '--', path)?.split('\n')[0] ?? ''
      const m = /^(100644|100755) blob [0-9a-f]+\s+(\d+)\t/.exec(entry)
      if (m === null || Number(m[2]) > MAX_REPORT) return undefined
      const text = tryGit('cat-file', 'blob', `HEAD:${path}`)
      return text === undefined ? undefined : parseReport(text)
    },
    inHistory: commit => isCommit(commit) && tryGit('merge-base', '--is-ancestor', commit, head) !== undefined,
    changedSince: commit => (tryGit('diff', '--name-only', '--no-renames', '-z', commit, head) ?? '').split('\0').filter(p => p !== ''),
    samePrChange: (commit, path) => {
      const final = blob(head, path)
      if (blob(commit, path) === final) return true
      // base 带来的变化：证据提交与 base 的分叉点 → PR 最新提交与 base 的分叉点。补到证据提交的版本上，看是否等于最终版本
      const mbThen = tryGit('merge-base', commit, base())?.trim()
      const mbNow = tryGit('merge-base', head, base())?.trim()
      if (mbThen === undefined || mbNow === undefined || mbThen === mbNow) return false
      const [tested, before, after] = [content(commit, path), content(mbThen, path), content(mbNow, path)]
      if (tested === undefined || before === undefined || after === undefined) return false
      const dir = mkdtempSync(join(tmpdir(), 'pr-checklist-'))
      try {
        const files = ['tested', 'before', 'after'].map(n => join(dir, n))
        writeFileSync(files[0]!, tested)
        writeFileSync(files[1]!, before)
        writeFileSync(files[2]!, after)
        // 有冲突时 merge-file 退出码非 0，当成对不上
        const merged = tryGit('merge-file', '-p', files[0]!, files[1]!, files[2]!)
        return merged !== undefined && merged === content(head, path)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

function main(): void {
  const body = process.env.PR_BODY ?? ''
  const changed = parseNameStatusZ(execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD'], { encoding: 'utf8' }))
  const rules = parseRules(readFileSync(new URL('../e2e-paths.txt', import.meta.url), 'utf8'))
  // 工作流传入 PR 的最新提交；检出的合并提交的第二个父提交必须就是它，否则核对的对象不对
  const head = process.env.PR_HEAD_SHA ?? ''
  const parent2 = (() => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD^2'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  })()
  const repo = /^[0-9a-f]{40}$/.test(head) && parent2 === head ? gitRepo(process.cwd(), head) : undefined
  const r = check({ body, changed, rules, ...(repo === undefined ? {} : { repo }) })
  if (repo === undefined) console.log(`::warning title=需要人确认::没有核对证据对得上最终代码：检出的不是 PR 的合并提交，或者没传 PR_HEAD_SHA（HEAD^2=${parent2 || '无'}）`)
  for (const n of r.notes) console.log(n)
  for (const w of r.warnings) console.log(`::warning title=需要人确认::${w}`)
  for (const e of r.errors) console.log(`::error title=PR 流程检查::${e}`)
  if (r.errors.length > 0) process.exit(1)
  console.log('PR 流程检查通过')
}

if (import.meta.main) main()
