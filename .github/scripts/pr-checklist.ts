// 检查 PR 有没有走完 CLAUDE.md 自检里的流程（只查形式）：
//   - 描述里有「能用证据证明的」「证明不了的」两节，且不是空的（自检第 7 条）
//   - 改动碰到 .github/e2e-paths.txt 里「需要」的路径时，描述里有「端到端验证」一节（自检第 3 条）：
//     写了 docs/e2e/ 下的证据路径的，路径必须在这个 PR 里新增或修改过；
//     写了「不需要，理由……」的，通过但给出醒目的提示
// 只能证明「有这几节、证据文件存在」，证明不了 E2E 真的覆盖了这次改动。
//
// 用法（在 PR 的合并提交上）：PR_BODY="..." node <脚本>
// 改动列表取 HEAD^1..HEAD，即 actions/checkout 检出的合并提交相对 base 的改动。
// 规则文件取脚本旁边的 ../e2e-paths.txt。工作流从 base（HEAD^1）取出脚本和规则来跑，
// 这样 PR 不能靠改脚本或规则放宽对自己的检查；改动要等合并后才对后面的 PR 生效。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

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
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') re += '[^/]*'
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/** 第一条匹配到的规则算数；都不匹配时默认需要。 */
export function needsE2E(path: string, rules: Rule[]): boolean {
  return rules.find((r) => r.regex.test(path))?.need ?? true
}

/** 按标题切分描述。代码块里的「#」不算标题，HTML 注释不算内容。 */
export function sections(body: string): { title: string; content: string }[] {
  const out: { title: string; level: number; open: boolean; lines: string[] }[] = []
  // 代码块只由开始时的那种标记（``` 或 ~~~）结束
  let fence: string | null = null
  for (const line of body.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
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
  return out.map((s) => ({ title: s.title, content: s.lines.join('\n').trim() }))
}

/** 决定 CI 查什么、放行什么的文件。PR 改它们就能放宽自己的检查，所以要醒目地提示。 */
export function isGuardFile(path: string): boolean {
  return path === '.gitleaksignore' || path === '.gitleaks.toml' || path === '.github/e2e-paths.txt' ||
    path.startsWith('.github/workflows/') || path.startsWith('.github/scripts/')
}

export type Result = { errors: string[]; warnings: string[]; notes: string[] }

/** 这个 PR 改动的一个文件。删掉的文件算「改动」（要不要 E2E），但不能当证据。 */
export type Change = { path: string; deleted: boolean }

export function check(input: { body: string; changed: Change[]; rules: Rule[] }): Result {
  const r: Result = { errors: [], warnings: [], notes: [] }
  const all = sections(input.body)
  const find = (pred: (t: string) => boolean) => all.find((s) => pred(s.title))

  const required: [string, (t: string) => boolean][] = [
    ['能用证据证明的', (t) => /^(能用证据证明的|能证明的)/.test(t)],
    ['证明不了的', (t) => t.startsWith('证明不了的')],
  ]
  for (const [name, pred] of required) {
    const s = find(pred)
    if (!s) r.errors.push(`描述里缺少「${name}」一节（CLAUDE.md 自检第 7 条）`)
    else if (s.content === '') r.errors.push(`「${s.title}」一节是空的`)
  }

  const paths = input.changed.map((c) => c.path)
  const present = input.changed.filter((c) => !c.deleted).map((c) => c.path)
  const guards = paths.filter(isGuardFile)
  if (guards.length > 0) {
    r.warnings.push(`这个 PR 改了检查规则或允许清单（${guards.join('、')}）。放宽规则要人批：独立审查核实，合并卡片上单独列出`)
  }

  const needed = paths.filter((p) => needsE2E(p, input.rules))
  if (needed.length === 0) {
    r.notes.push('改动没有碰到需要 E2E 的路径（.github/e2e-paths.txt），不要求「端到端验证」一节')
    return r
  }
  r.notes.push(`需要 E2E 的改动：${needed.slice(0, 10).join('、')}${needed.length > 10 ? ` 等 ${needed.length} 个文件` : ''}`)

  const e2e = find((t) => t.startsWith('端到端验证'))
  if (!e2e || e2e.content === '') {
    r.errors.push('改动碰到了需要 E2E 的路径，描述里要有非空的「端到端验证」一节：写 docs/e2e/ 下的证据路径，或写「不需要，理由是……」（CLAUDE.md 自检第 3 条）')
    return r
  }
  // 路径里的 * 不当通配：截到它前面的目录，按目录匹配
  const evidence = [...e2e.content.matchAll(/docs\/e2e\/[^\s`'"<>()（）\[\]，,。；;：:、*]+/g)].map((m) => m[0].replace(/[.)]+$/, ''))
  if (evidence.length > 0) {
    for (const p of new Set(evidence)) {
      const dir = p.endsWith('/') ? p : `${p}/`
      if (!present.some((c) => c === p || c.startsWith(dir))) {
        r.errors.push(`「端到端验证」写的证据 ${p} 不在这个 PR 新增或修改的文件里`)
      }
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

function main(): void {
  const body = process.env.PR_BODY ?? ''
  const changed: Change[] = execFileSync('git', ['diff', '--name-status', '--no-renames', 'HEAD^1', 'HEAD'], { encoding: 'utf8' })
    .split('\n').filter((l) => l !== '')
    .map((l) => { const [status, ...rest] = l.split('\t'); return { path: rest.join('\t'), deleted: status === 'D' } })
  const rules = parseRules(readFileSync(new URL('../e2e-paths.txt', import.meta.url), 'utf8'))
  const r = check({ body, changed, rules })
  for (const n of r.notes) console.log(n)
  for (const w of r.warnings) console.log(`::warning title=需要人确认::${w}`)
  for (const e of r.errors) console.log(`::error title=PR 流程检查::${e}`)
  if (r.errors.length > 0) process.exit(1)
  console.log('PR 流程检查通过')
}

if (import.meta.main) main()
