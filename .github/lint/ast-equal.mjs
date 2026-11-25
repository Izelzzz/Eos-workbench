// 比较每个改动的代码文件格式化前（base）和格式化后（工作区）的语法树。
// 只比节点类型和标识符、字面量的值，不比位置、空白、注释、引号写法、行尾逗号。
// 以下几种写法不同、含义相同，先统一再比：
// - 多余的括号；
// - 对象键加不加引号（'a': 和 a:）；
// - 空语句（semi:false 时 Prettier 在 ( [ ` 开头的行前补的 ;）；
// - JSX 文本按 React 的规则处理：每行去掉首尾空白、丢掉空行、行间用一个空格连接；结果为空的不算；
//   元素里只含一个字符串的 {' '} 当成同样内容的文本。
// 用法（仓库根目录，先 npm ci --prefix .github/lint --ignore-scripts）：node .github/lint/ast-equal.mjs [base]
// base 默认 HEAD：比较 base 和工作区。全部一致时退出码 0，有不一致时列出文件、退出码 1。
// 用途：大范围格式化（例如 bash .github/lint/check-format.sh --write）之后，证明只改了格式、没改代码的含义。
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const require = createRequire(process.cwd() + '/.github/lint/package.json')
const ts = require('typescript')
const base = process.argv[2] ?? 'HEAD'
const files = execFileSync('git', ['diff', '--name-only', base, '--', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
const kindOf = f => (f.endsWith('x') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS)

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
    if (ts.isParenthesizedExpression(n)) return walk(n.expression)
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
    else if (ts.isBinaryExpression(n)) out.push('op' + n.operatorToken.kind)
    else if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) out.push('op' + n.operator)
    n.forEachChild(walk)
    flush()
    out.push(')')
  }
  walk(sf)
  return out
}

let same = 0
const diff = []
for (const f of files) {
  const a = shape(f, execFileSync('git', ['show', `${base}:${f}`], { encoding: 'utf8' }))
  const b = shape(f, readFileSync(f, 'utf8'))
  if (a.length === b.length && a.every((x, i) => x === b[i])) same++
  else {
    const i = a.findIndex((x, k) => x !== b[k])
    diff.push(`${f}（第 ${i} 个节点：${a.slice(i, i + 6).join(' ')} ≠ ${b.slice(i, i + 6).join(' ')}）`)
  }
}
console.log(`改动的代码文件 ${files.length} 个；语法树一致 ${same} 个；不一致 ${diff.length} 个`)
for (const d of diff) console.log('  不一致：' + d)
process.exit(diff.length ? 1 : 0)
