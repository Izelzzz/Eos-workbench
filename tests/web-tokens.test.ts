// 设计令牌只有一个出处：web/src/tokens.css。别的样式和组件里不能直接写颜色、字体、字号、字重、圆角，
// 也不能另外声明 CSS 变量；Tailwind 只用令牌生成的类，不用任意值（text-[13px]、p-[7px]）。
// 现有页面的 styles.css 里的间距（padding、margin、gap）还是直接写的数值，这里不查；新代码用 Tailwind 的间距类。
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'

const WEB = join(import.meta.dirname, '..', 'web', 'src')
const TOKENS = 'tokens.css'

type Rule = { what: string; pattern: RegExp }

// .css 文件：写在 CSS 声明里的值
const CSS_RULES: Rule[] = [
  { what: '声明 CSS 变量', pattern: /(^|[{;\s])--[\w-]+\s*:/ },
  // 选择器里的 #id（后面跟 {、, 或别的选择器）不算；值可以写在声明的下一行，所以不要求同一行有冒号
  { what: '颜色值', pattern: /#[0-9a-fA-F]{3,8}(?![\w-])(?!\s*[{,.:#[>+~])|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/ },
  { what: '颜色名', pattern: /(color|background|border|outline|fill|stroke|shadow)[\w-]*\s*:[^;{}]*(?<![-\w])(red|orange|yellow|green|blue|purple|pink|white|black|gray|grey|silver|navy)\b/i },
  // 字号、字重、字体只能是 var(--…) 或 inherit；font 简写里的字号和字体都要引用令牌
  { what: '字号', pattern: /font-size\s*:(?!\s*(var\(|inherit))/ },
  { what: '字重', pattern: /font-weight\s*:(?!\s*(var\(|inherit))/ },
  { what: '字体', pattern: /font-family\s*:(?!\s*(var\(|inherit))/ },
  { what: 'font 简写', pattern: /(^|[{;\s])font\s*:(?!\s*(inherit|var\(--text-[\w-]+\)\/([\d.]+|var\(--leading-[\w-]+\))\s+var\(--font-[\w-]+\))\s*[;}])/ },
  { what: '圆角', pattern: /border(-[a-z]+)*-radius\s*:[^;}]*\d(px|rem|em)\b/ },
  { what: '引入整个 Tailwind（含 preflight 和默认主题）', pattern: /@import\s+["']tailwindcss(\/preflight|\/theme)?(\.css)?["']/ },
]

// .ts/.tsx 文件：内联样式和 Tailwind 类名里的值
const SPACING = 'p|px|py|ps|pe|pt|pr|pb|pl|m|mx|my|ms|me|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|w|h|size|min-w|min-h|max-w|max-h|inset|top|left|right|bottom|translate-x|translate-y'
const TS_RULES: Rule[] = [
  { what: '颜色值', pattern: /['"`]#[0-9a-fA-F]{3,8}['"`]|\[#[0-9a-fA-F]{3,8}\]|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/ },
  { what: '内联样式里的字体、字号、字重、圆角、颜色', pattern: /style=\{\{[^}]*\b(font|fontSize|fontWeight|fontFamily|borderRadius|color|background|backgroundColor|borderColor)\s*:/ },
  { what: 'Tailwind 任意属性', pattern: /\[[a-z-]+:[^\]]+\]/ },
  { what: 'Tailwind 引用任意变量', pattern: /\b[a-z-]+-\((--|[a-z]+:--)/ },
  { what: 'Tailwind 任意值（字号、颜色、字重、字体、圆角）', pattern: /\b(text|bg|border|ring|outline|fill|stroke|font|rounded(-[trbl]{1,2})?|shadow|leading|tracking)-\[/ },
  { what: 'Tailwind 任意值（间距、尺寸）', pattern: new RegExp(`(^|[\\s"'\`:])-?(${SPACING})-\\[`) },
  {
    what: 'Tailwind 默认调色板（令牌以外的颜色）',
    pattern:
      /\b(text|bg|border|ring|outline|fill|stroke|from|to|via|divide|accent|caret|decoration)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/,
  },
]

const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
// 只去掉整行的 // 注释和 /* */ 注释：行内的 // 可能在字符串里（例如 '//docs'），去掉会漏查同一行后面的内容
const stripTsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, m => m.replace(/[^\n]/g, ' '))

export const violations = (file: string, source: string): string[] => {
  const css = file.endsWith('.css')
  const rules = css ? CSS_RULES : TS_RULES
  const lines = (css ? stripCssComments(source) : stripTsComments(source)).split('\n')
  return lines.flatMap((line, i) => rules.filter(r => r.pattern.test(line)).map(r => `${file}:${i + 1} ${r.what}：${line.trim()}`))
}

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return files(p)
    return /\.(css|ts|tsx)$/.test(e.name) ? [p] : []
  })

test('web/src 里只有 tokens.css 定义颜色、字体、字号、字重、圆角', () => {
  const found = files(WEB)
    .filter(f => relative(WEB, f) !== TOKENS)
    .flatMap(f => violations(relative(WEB, f), readFileSync(f, 'utf8')))
  assert.deepEqual(found, [], `改成引用 web/src/${TOKENS} 里的令牌（CSS 用 var(--…)，组件用 Tailwind 的令牌类），需要新令牌就加到 ${TOKENS}`)
})

test('tokens.css 定义了亮色和暗色的调色板，以及字号、圆角、间距和组件用的语义颜色', () => {
  const t = readFileSync(join(WEB, TOKENS), 'utf8')
  const light = t.slice(t.indexOf(':root {'), t.indexOf('}', t.indexOf(':root {')))
  const darkStart = t.indexOf('@media (prefers-color-scheme: dark)')
  assert.ok(darkStart > 0, '缺暗色调色板')
  const dark = t.slice(darkStart, t.indexOf('}', darkStart))
  for (const name of ['--bg', '--surface', '--ink', '--ink-2', '--ink-3', '--line', '--fill', '--fill-2', '--accent', '--accent-soft', '--card-shadow', '--popover-shadow']) {
    assert.match(light, new RegExp(`${name}:`), `亮色缺 ${name}`)
    assert.match(dark, new RegExp(`${name}:`), `暗色缺 ${name}`)
  }
  for (const name of [
    '--font-sans',
    '--font-mono',
    '--text-base',
    '--radius-md',
    '--spacing',
    '--color-surface',
    '--color-ink',
    '--color-ink-2',
    '--color-line',
    '--color-accent',
    '--color-destructive',
    '--shadow-card',
    '--shadow-popover',
  ]) {
    assert.match(t, new RegExp(`${name}:`), `缺 ${name}`)
  }
})

test('样式入口不引入 preflight，现有页面的样式在组件和工具类之前的层，也不经 Tailwind 扫描和编译', () => {
  const index = stripCssComments(readFileSync(join(WEB, 'index.css'), 'utf8'))
  assert.match(index, /@layer theme, base, legacy, components, utilities;/)
  // source(none)：不扫描现有页面，免得它们的类名（block、grow）生成同名的工具类盖过 styles.css
  assert.match(index, /@import "tailwindcss\/utilities\.css" layer\(utilities\) source\(none\);/)
  assert.doesNotMatch(index, /preflight|tailwindcss\/theme|@import "tailwindcss"|styles\.css/)
  const styles = stripCssComments(readFileSync(join(WEB, 'styles.css'), 'utf8')).trim()
  assert.ok(styles.startsWith('@layer legacy {') && styles.endsWith('}'), 'styles.css 的全部规则要在 @layer legacy { } 里')
  // 括号配平：第一个 { 只在文件末尾闭合，层后面不能再有规则
  let depth = 0
  for (let i = 0; i < styles.length; i++) {
    if (styles[i] === '{') depth++
    if (styles[i] === '}' && --depth === 0) assert.equal(i, styles.length - 1, 'legacy 层闭合之后还有规则，它们不在层里，会盖过组件的工具类')
  }
  assert.match(index, /@import "\.\/tokens\.css";/)
  assert.match(readFileSync(join(WEB, 'main.tsx'), 'utf8'), /import '\.\/index\.css'\nimport '\.\/styles\.css'/)
})

test('检查能发现直接写的值', () => {
  const css = [
    '.a { color: #fff; }',
    '.b { font-size: 13px; }',
    '.c { border-radius: 6px; }',
    '.d { --x: 1px; }',
    '.e { font-weight: 600; }',
    '.f { background: rgba(0,0,0,.1); }',
    '.g { font-family: Arial; }',
    '.h { font-weight: bold; }',
    '.i { font-size: small; }',
    '.j { font: bold 13px Arial; }',
    '.k { font: var(--text-sm)/1.5 Arial; }',
    '.l { color: red; }',
    '.m { background: white; }',
    '.n { border-top-left-radius: 6px; }',
    '.o { color: color(srgb 1 0 0); }',
    '  #fff;',
    '.q { color: Red; }',
  ]
  for (const line of css) assert.ok(violations('x.css', line).length > 0, line)
  const tsx = [
    '<p className="text-[13px]" />',
    '<p className="bg-[#fff]" />',
    '<p className="p-[7px]" />',
    '<p className="rounded-[6px]" />',
    '<p className="text-blue-500" />',
    '<p style={{ fontSize: 13 }} />',
    "const c = '#ff0000'",
    '<p className="[font-size:13px]" />',
    `<a href={'//docs'} className="text-[13px]" />`,
    '<p className="bg-(--x)" />',
    '<p className="text-(length:--x)" />',
  ]
  for (const line of tsx) assert.ok(violations('x.tsx', line).length > 0, line)
  const ok = [
    '.a { color: var(--text); border-radius: 50%; font: inherit; }',
    '/* #fff 13px */',
    '<a href="#/tasks/123">#123</a>',
    '<p className="text-sm text-ink-2 p-2 rounded-card bg-surface shadow-card" />',
    '<span style={{ paddingLeft: depth * 16 }} />',
    'type Label = { color: string }',
    '#add-btn { color: var(--text); }',
    '.a:hover #add-btn, #fade { color: var(--color-green); border: 1px solid var(--red); }',
    '.p { background: transparent; color: currentColor; }',
    '.b { font: var(--text-sm)/1.5 var(--font-mono); font-weight: var(--font-weight-semibold); }',
  ]
  for (const line of ok) assert.deepEqual(violations(line.startsWith('.') ? 'x.css' : 'x.tsx', line), [], line)
})
