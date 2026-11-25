// 比较每个改动的代码文件格式化前（base）和格式化后（工作区）的语法树，证明大范围格式化只改了格式。
//
// 比什么：节点类型、标识符和字面量的值，以及节点上的其他基本类型属性（const/let、import type、extends/implements、
// keyof/unique、export =/export default、可选链等都存在属性或 flags 里）；位置、缓存这类和含义无关的属性不比。
// 空白、注释、引号写法、行尾逗号不比。以下几种写法不同、含义相同，先统一再比：
// - 多余的括号。会改变含义的保留：截断可选链的 (a?.b).c，指令序言里的 ('use strict')；
// - 对象键加不加引号（'a': 和 a:）；
// - 空语句（semi:false 时 Prettier 在 ( [ ` 开头的行前补的 ;）；
// - JSX 文本按 React（Babel）的规则处理：每行去掉首尾空白、丢掉空行、行间用一个空格连接，结果为空的不算；
//   元素里只含一个字符串的 {' '} 当成同样内容的文本，相邻的文本合在一起比。
//   所以这里证明的是渲染出来的文字一样；相邻文本是一个 children 还是拆成几个，不比（读 props.children 结构的组件
//   要另外核对）。
//
// 证明不了、算失败（退出码 1）的：
// - 含指令注释（// @ts-expect-error、eslint-disable、prettier-ignore、@__PURE__ 等）的文件：指令作用于它后面的行或节点，
//   换行可能改变作用对象。列为「需要人工核对」；
// - 新增、删除、改名、类型改变（例如变成符号链接）的文件：只比较两边都有的普通文件。
//
// 用法（仓库根目录，先 npm ci --prefix .github/lint --ignore-scripts）：node .github/lint/ast-equal.mjs [base]
// base 默认 HEAD：比较 base 和工作区。全部一致时退出码 0，否则列出文件、退出码 1。
// 用途：大范围格式化（例如 bash .github/lint/check-format.sh --write）之后，证明只改了格式、没改代码的含义。
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const require = createRequire(process.cwd() + '/.github/lint/package.json')
const ts = require('typescript')
const base = process.argv[2] ?? 'HEAD'
const CODE = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs']
const listed = filter =>
  execFileSync('git', ['diff', '--name-only', '--no-renames', `--diff-filter=${filter}`, base, '--', ...CODE], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
const kindOf = f => (f.endsWith('x') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS)

// 和含义无关的属性：位置、缓存、源文件的元信息；text/escapedText 在下面按节点类型单独记
const SKIP = new Set([
  'pos',
  'end',
  'id',
  'parent',
  'modifierFlagsCache',
  'transformFlags',
  'text',
  'escapedText',
  'fileName',
  'path',
  'resolvedPath',
  'originalFileName',
  'languageVersion',
  'languageVariant',
  'scriptKind',
  'isDeclarationFile',
  'hasNoDefaultLib',
  'nodeCount',
  'identifierCount',
  'symbolCount',
  'jsDocParsingMode',
  // 排版：对象、数组、块写成一行还是多行
  'multiLine',
  // flags 里大多是解析过程的信息（例如有没有 JSDoc、子树里有没有 this），只比下面 MEANING_FLAGS 里和含义有关的几位
  'flags',
])
const MEANING_FLAGS =
  ts.NodeFlags.Let |
  ts.NodeFlags.Const |
  ts.NodeFlags.Using |
  ts.NodeFlags.AwaitUsing |
  ts.NodeFlags.OptionalChain |
  ts.NodeFlags.Namespace |
  ts.NodeFlags.NestedNamespace |
  ts.NodeFlags.GlobalAugmentation |
  ts.NodeFlags.ExportContext

// 指令注释：注释一开头就是这些
// 三斜线指令（/// <reference ...>）只在文件开头生效，也算
const DIRECTIVE = /^(\/\/\/\s*<|\/[/*]\s*(@ts-|eslint-|eslint\s|prettier-ignore|[@#]__PURE__|[@#]__NO_SIDE_EFFECTS__|@vite-ignore|webpack[A-Z]|c8\s|istanbul\s|v8\s|@jsx))/

// React（Babel）的 cleanJSXElementLiteralChild，lastNonEmptyLine 初始为 0
function jsxText(t) {
  const lines = t.split(/\r\n|\n|\r/)
  let last = 0
  lines.forEach((l, i) => {
    if (/[^ \t]/.test(l)) last = i
  })
  let s = ''
  lines.forEach((l, i) => {
    let x = l.replace(/\t/g, ' ')
    if (i !== 0) x = x.replace(/^[ ]+/, '')
    if (i !== lines.length - 1) x = x.replace(/[ ]+$/, '')
    if (x) {
      if (i !== last) x += ' '
      s += x
    }
  })
  return s
}

const isName = n => n.parent && (ts.isPropertyAssignment(n.parent) || ts.isPropertySignature(n.parent) || ts.isMethodDeclaration(n.parent) || ts.isPropertyDeclaration(n.parent)) && n.parent.name === n

// 括号去掉会改变含义的情况
const parenMatters = n =>
  ts.isOptionalChain(n.expression) ||
  (ts.isExpressionStatement(n.parent) && ts.isStringLiteral(n.expression)) ||
  // (a?.b).c 里括号的 flags 也带 OptionalChain 信息，保守起见：里面是可选链的一律保留
  (n.expression.flags & ts.NodeFlags.OptionalChain) !== 0 ||
  // JS 里 /** @type {T} */ (x) 是类型转换，括号不能去
  (n.jsDoc?.length ?? 0) > 0

// 从语法树按 token 取注释（不自己扫描全文：模板字符串、JSX 文本里的 /* 和 // 会打乱扫描）
function directives(f, src) {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kindOf(f))
  // 已经报出的指令注释的位置（去重）
  const seen = new Set()
  const found = []
  const take = ranges => {
    for (const r of ranges ?? []) {
      const t = src.slice(r.pos, r.end)
      if (seen.has(r.pos) || !DIRECTIVE.test(t)) continue
      seen.add(r.pos)
      found.push(t)
    }
  }
  const walk = n => {
    // JSDoc 节点里面不再往下找：JSDoc 正文里写的 // 不是注释；JSDoc 本身在它所属节点的前导注释里已经取过
    if (ts.isJSDoc(n)) return
    take(ts.getLeadingCommentRanges(src, n.pos))
    take(ts.getTrailingCommentRanges(src, n.end))
    // getChildren 连标点和关键字 token 也给（= ( , { 等），forEachChild 只给节点：跟在 token 后面的注释会漏
    for (const c of n.getChildren(sf)) walk(c)
  }
  walk(sf)
  take(ts.getLeadingCommentRanges(src, sf.endOfFileToken.pos))
  // TypeScript 自己认出的 @ts-ignore / @ts-expect-error（它的写法比上面的正则宽：/// @ts-ignore、/** @ts-ignore */、
  // 块注释最后一行的 @ts-expect-error 都算）
  for (const d of sf.commentDirectives ?? []) {
    if (seen.has(d.range.pos)) continue
    seen.add(d.range.pos)
    found.push(src.slice(d.range.pos, d.range.end))
  }
  return found
}

function shape(f, src) {
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, kindOf(f))
  if (sf.parseDiagnostics.length) throw new Error(`${f}: 解析错误`)
  const out = []
  let text = null
  const flush = () => {
    if (text) out.push('JsxText=' + JSON.stringify(text))
    text = null
  }
  const walk = n => {
    if (ts.isParenthesizedExpression(n) && !parenMatters(n)) return walk(n.expression)
    if (ts.isParenthesizedTypeNode(n)) return walk(n.type)
    if (n.kind === ts.SyntaxKind.EmptyStatement) return
    if (ts.isJsxText(n)) {
      text = (text ?? '') + jsxText(n.text)
      return
    }
    if (ts.isJsxExpression(n) && n.expression && ts.isStringLiteral(n.expression) && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      text = (text ?? '') + n.expression.text
      return
    }
    flush()
    if ((ts.isStringLiteral(n) || ts.isIdentifier(n)) && isName(n)) {
      out.push('Name=' + n.text)
      return
    }
    out.push(ts.SyntaxKind[n.kind])
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) out.push('=' + n.text)
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isRegularExpressionLiteral(n))
      out.push('=' + JSON.stringify(n.text))
    else if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n)) out.push('=' + n.text)
    if (!ts.isSourceFile(n)) {
      out.push(`flags:${n.flags & MEANING_FLAGS}`)
      for (const k of Object.keys(n).sort()) {
        const v = n[k]
        if (!SKIP.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out.push(`${k}:${v}`)
      }
    }
    n.forEachChild(walk)
    flush()
    out.push(')')
  }
  walk(sf)
  return out
}

let same = 0
const problems = []
for (const f of listed('ADRTUXB')) problems.push(`新增、删除、改名或类型改变（只比较两边都有的普通文件）：${f}`)
const files = listed('M')
for (const f of files) {
  const before = execFileSync('git', ['show', `${base}:${f}`], { encoding: 'utf8' })
  const after = readFileSync(f, 'utf8')
  try {
    const d = [...directives(f, before), ...directives(f, after)]
    if (d.length) {
      problems.push(`需要人工核对（含指令注释 ${d.slice(0, 3).join(' | ')}）：${f}`)
      continue
    }
    const a = shape(f, before)
    const b = shape(f, after)
    if (a.length === b.length && a.every((x, i) => x === b[i])) same++
    else {
      const i = a.findIndex((x, k) => x !== b[k])
      problems.push(`不一致：${f}（第 ${i} 项：${a.slice(i, i + 6).join(' ')} ≠ ${b.slice(i, i + 6).join(' ')}）`)
    }
  } catch (e) {
    problems.push(`出错：${f}：${e.message}`)
  }
}
console.log(`两边都有的改动代码文件 ${files.length} 个；语法树一致 ${same} 个；其他问题 ${problems.length} 个`)
for (const p of problems) console.log('  ' + p)
process.exit(problems.length ? 1 : 0)
