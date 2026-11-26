// 校验 Trivy 的豁免清单（.trivyignore.yaml），由 image-scan.sh 在扫描前运行。只用 Node 自带的模块，image 的 job 里不装依赖也能跑。
// 只认一种严格的写法：Trivy 能接受的写法很多（流式写法、purls: [] 表示不限包、键名加引号……），有的会悄悄放宽豁免，
// 所以这里按行逐条匹配，不认识的行一律报错。每条豁免都必须写全四项：
//   - id: CVE-…              漏洞编号
//     purls: ['pkg:…@版本']   至少一个，每个都锁到版本（升级后自动不再匹配）
//     statement: 理由         一行，不为空
//     expired_at: YYYY-MM-DD  不加引号（Trivy 0.76 解析不了带引号的日期），必须是真实存在的日期
// 用法：node .github/scripts/trivyignore-check.ts <.trivyignore.yaml> <今天，YYYY-MM-DD> <输出文件>
// 输出：GitHub 的 ::error / ::warning 行；有错误时退出码 1。校验通过时把解析出的条目重新写成 JSON（也是合法的 YAML）到输出文件，
// image-scan.sh 交给 Trivy 的是这份文件，不是原文件：Trivy 看到的豁免和这里校验过的完全一样，YAML 解析上的差异（隐形换行、
// 跨行的引号字符串之类，几轮独立审查各找到过一种）就算漏过了逐行校验，也不会让豁免变宽。
import { readFileSync, writeFileSync } from 'node:fs'

export type Entry = { id: string; purls: string[]; statement: string; expiredAt: string; line: number }
export type Checked = { entries: Entry[]; errors: string[]; warnings: string[] }

const KEYS = ['purls', 'statement', 'expired_at'] as const
const DAY = 86_400_000

/** YYYY-MM-DD 且是真实存在的日期（排除 2026-02-30 这种） */
export function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** 一行里的 purls 列表：['a', 'b'] 或 ["a"]，每个都带 @版本 */
function parsePurls(v: string): string[] | undefined {
  const m = /^\[(.*)\]$/.exec(v)
  if (m === null) return undefined
  const items = m[1]!.split(',').map(x => x.trim())
  // 只认单引号（双引号里有转义，例如 \x23 解码后是 #）；版本只认这几种字符：# 后面是 subpath、? 后面是 qualifier，都会让版本失效
  // 名字按 / 分段，每段非空、不是 . 或 ..（这类写法 Trivy 匹配不上或解析失败，等于写错了）
  const ok = (x: string) => {
    const m = /^'pkg:[a-z]+\/([A-Za-z0-9._~/-]+)@[A-Za-z0-9.+_~-]+'$/.exec(x)
    return m !== null && m[1]!.split('/').every(seg => seg !== '' && seg !== '.' && seg !== '..')
  }
  if (items.length === 0 || !items.every(ok)) return undefined
  return items.map(x => x.slice(1, -1))
}

export function check(text: string, today: string): Checked {
  const errors: string[] = []
  const warnings: string[] = []
  const entries: Entry[] = []
  let seenRoot = false
  let cur: (Partial<Record<(typeof KEYS)[number], string | string[]>> & { id: string; line: number }) | undefined
  const finish = () => {
    if (cur === undefined) return
    const missing = KEYS.filter(k => cur![k] === undefined)
    if (missing.length > 0) errors.push(`第 ${cur.line} 行的豁免 ${cur.id} 缺少 ${missing.join('、')}`)
    else entries.push({ id: cur.id, purls: cur.purls as string[], statement: cur.statement as string, expiredAt: cur.expired_at as string, line: cur.line })
    cur = undefined
  }
  // YAML 还把单独的 \r、U+0085、U+2028、U+2029 当换行，按 \n 切行就看不到：藏在注释或 statement 里的「换行」能偷偷多出一条豁免。
  // 所以整个文件只允许 \n 换行和可见字符，别的控制字符、这几种换行、BOM 一律拒绝
  const bad = [...text].findIndex(ch => {
    const c = ch.codePointAt(0)!
    // 另外拒绝 ASCII 空格以外的空白（U+00A0、U+3000 等）：JS 的 \s 认它们，YAML 不认，两边对一行的理解会不同
    return (c < 0x20 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || c === 0xfeff || (c !== 0x20 && /\p{Zs}/u.test(ch))
  })
  if (bad >= 0) {
    const chars = [...text]
    const n = chars.slice(0, bad).join('').split('\n').length
    const code = chars[bad]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    return { entries: [], errors: [`第 ${n} 行有不可见的控制字符（U+${code}）：只允许普通文字和换行（LF）`], warnings: [] }
  }
  text.split('\n').forEach((raw, i) => {
    const n = i + 1
    const line = raw.replace(/ +$/, '')
    if (line === '' || /^ *#/.test(line)) return
    if (line === 'vulnerabilities:') {
      if (seenRoot) errors.push(`第 ${n} 行：vulnerabilities 写了两次`)
      seenRoot = true
      return
    }
    if (!seenRoot) return void errors.push(`第 ${n} 行：只认 vulnerabilities 一节，按 .trivyignore.yaml 开头注释里的写法写`)
    const start = /^ {2}- id: (CVE-\d{4}-\d+|GHSA(-[0-9a-z]{4}){3})$/.exec(line)
    if (start !== null) {
      finish()
      cur = { id: start[1]!, line: n }
      return
    }
    const field = /^ {4}(purls|statement|expired_at): (\S.*)$/.exec(line)
    if (field === null || cur === undefined) return void errors.push(`第 ${n} 行写法不认识：每条豁免以「  - id: CVE-…」开头，下面四个空格缩进写 purls、statement、expired_at，各一行`)
    const key = field[1] as (typeof KEYS)[number]
    const value = field[2]!
    if (cur[key] !== undefined) return void errors.push(`第 ${n} 行：豁免 ${cur.id} 的 ${key} 写了两次`)
    if (key === 'purls') {
      const p = parsePurls(value)
      if (p === undefined) return void errors.push(`第 ${n} 行：purls 要写成一行列表，至少一个，每个都锁到版本，例如 ['pkg:npm/undici@8.11.2']`)
      cur.purls = p
    } else if (key === 'expired_at') {
      if (!isDate(value)) return void errors.push(`第 ${n} 行：expired_at 要写成不加引号、真实存在的日期 YYYY-MM-DD（Trivy 解析不了带引号的日期）`)
      cur.expired_at = value
    } else {
      // 以 YAML 的特殊字符开头、或者含「: 」「 #」时，Trivy 会解析成别的东西或直接报错
      // 只允许一行普通文字（YAML 的 plain scalar）：冒号后只有一个空格、不以特殊字符开头、不含引号（引号字符串能跨行，
      // 吞掉后面几行的 purls、expired_at）、不含「: 」和「 #」
      if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || /['"]/.test(value) || value.includes(': ') || value.includes(' #')) {
        return void errors.push(`第 ${n} 行：statement 写成一行普通文字：冒号后只空一格，不以 YAML 的特殊字符开头，不含引号、「: 」和「 #」`)
      }
      cur.statement = value
    }
  })
  finish()
  if (!seenRoot && errors.length === 0) errors.push('没有 vulnerabilities 一节')
  for (const e of entries) {
    const days = (Date.parse(`${e.expiredAt}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY
    if (days <= 0) warnings.push(`豁免 ${e.id}（第 ${e.line} 行）${e.expiredAt} 已经过期，不再生效：扫描会按没有豁免处理`)
    else if (days <= 7) warnings.push(`豁免 ${e.id}（第 ${e.line} 行）${e.expiredAt} 到期（还剩 ${days} 天）：到期后扫描会重新拦下，请提前重新评估`)
  }
  return { entries, errors, warnings }
}

/** 交给 Trivy 的豁免清单：只有校验过的四个字段；日期写成 RFC 3339（Trivy 解析带引号的日期只认这种写法），当天 UTC 0 点起失效 */
export function normalized(entries: Entry[]) {
  return { vulnerabilities: entries.map(e => ({ id: e.id, purls: e.purls, statement: e.statement, expired_at: `${e.expiredAt}T00:00:00Z` })) }
}

if (import.meta.main) {
  const [file, today, out] = process.argv.slice(2)
  if (file === undefined || today === undefined || !isDate(today) || out === undefined) {
    console.log('::error title=镜像漏洞扫描::用法：trivyignore-check.ts <.trivyignore.yaml> <今天 YYYY-MM-DD> <输出文件>')
    process.exit(1)
  }
  const r = check(readFileSync(file, 'utf8'), today)
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  for (const w of r.warnings) console.log(`::warning title=镜像漏洞扫描::.trivyignore.yaml：${esc(w)}`)
  for (const e of r.errors) console.log(`::error title=镜像漏洞扫描::.trivyignore.yaml：${esc(e)}`)
  if (r.errors.length > 0) process.exit(1)
  writeFileSync(out, `${JSON.stringify(normalized(r.entries), null, 2)}\n`)
  console.log(`.trivyignore.yaml 校验通过：${r.entries.length} 条豁免`)
}
