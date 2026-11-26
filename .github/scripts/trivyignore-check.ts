// 校验 Trivy 的豁免清单（.trivyignore.yaml），由 image-scan.sh 在扫描前运行。只用 Node 自带的模块，image 的 job 里不装依赖也能跑。
// 只认一种严格的写法：Trivy 能接受的写法很多（流式写法、purls: [] 表示不限包、键名加引号……），有的会悄悄放宽豁免，
// 所以这里按行逐条匹配，不认识的行一律报错。每条豁免都必须写全四项：
//   - id: CVE-…              漏洞编号
//     purls: ['pkg:…@版本']   至少一个，每个都锁到版本（升级后自动不再匹配）
//     statement: 理由         一行，不为空
//     expired_at: YYYY-MM-DD  不加引号（Trivy 0.76 解析不了带引号的日期），必须是真实存在的日期
// 用法：node .github/scripts/trivyignore-check.ts <.trivyignore.yaml> <今天，YYYY-MM-DD>
// 输出：GitHub 的 ::error / ::warning 行；有错误时退出码 1。
import { readFileSync } from 'node:fs'

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
  if (items.length === 0 || items.some(x => !/^'pkg:[a-z]+\/[A-Za-z0-9._~\/-]+@[A-Za-z0-9.+_~-]+'$/.test(x))) return undefined
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
  const bad = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.exec(text)
  if (bad !== null) {
    const n = text.slice(0, bad.index).split('\n').length
    return { entries: [], errors: [`第 ${n} 行有不可见的控制字符（U+${bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}）：只允许普通文字和换行（LF）`], warnings: [] }
  }
  text.split('\n').forEach((raw, i) => {
    const n = i + 1
    const line = raw.replace(/\s+$/, '')
    if (line === '' || /^\s*#/.test(line)) return
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
    const field = /^ {4}(purls|statement|expired_at): (.+)$/.exec(line)
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
      if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) || value.includes(': ') || value.includes(' #')) {
        return void errors.push(`第 ${n} 行：statement 写成一行普通文字：不以 YAML 的特殊字符开头，不含「: 」和「 #」`)
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

if (import.meta.main) {
  const [file, today] = process.argv.slice(2)
  if (file === undefined || today === undefined || !isDate(today)) {
    console.log('::error title=镜像漏洞扫描::用法：trivyignore-check.ts <.trivyignore.yaml> <今天 YYYY-MM-DD>')
    process.exit(1)
  }
  const r = check(readFileSync(file, 'utf8'), today)
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  for (const w of r.warnings) console.log(`::warning title=镜像漏洞扫描::.trivyignore.yaml：${esc(w)}`)
  for (const e of r.errors) console.log(`::error title=镜像漏洞扫描::.trivyignore.yaml：${esc(e)}`)
  if (r.errors.length > 0) process.exit(1)
  console.log(`.trivyignore.yaml 校验通过：${r.entries.length} 条豁免`)
}
