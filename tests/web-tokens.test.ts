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
  { what: '颜色值', pattern: /#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/ },
  { what: '字号', pattern: /font-size\s*:\s*[\d.]|font\s*:\s*[\d.]/ },
  { what: '字重', pattern: /font-weight\s*:\s*\d/ },
  { what: '字体', pattern: /font-family\s*:(?!\s*(var\(|inherit))/ },
  { what: '圆角', pattern: /border-radius\s*:[^;}]*\d(px|rem|em)\b/ },
  { what: '引入整个 Tailwind（含 preflight 和默认主题）', pattern: /@import\s+["']tailwindcss(\/preflight|\/theme)?(\.css)?["']/ },
]

// .ts/.tsx 文件：内联样式和 Tailwind 类名里的值
const SPACING = 'p|px|py|ps|pe|pt|pr|pb|pl|m|mx|my|ms|me|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|w|h|size|min-w|min-h|max-w|max-h|inset|top|left|right|bottom|translate-x|translate-y'
const TS_RULES: Rule[] = [
  { what: '颜色值', pattern: /['"`]#[0-9a-fA-F]{3,8}['"`]|\[#[0-9a-fA-F]{3,8}\]|\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/ },
  { what: '内联样式里的字体、字号、字重、圆角、颜色', pattern: /\b(fontSize|fontWeight|fontFamily|borderRadius|color|background|backgroundColor|borderColor)\s*:/ },
  { what: 'Tailwind 任意值（字号、颜色、字重、字体、圆角）', pattern: /\b(text|bg|border|ring|outline|fill|stroke|font|rounded(-[trbl]{1,2})?|shadow|leading|tracking)-\[/ },
  { what: 'Tailwind 任意值（间距、尺寸）', pattern: new RegExp(`(^|[\\s"'\`:])-?(${SPACING})-\\[`) },
  {
    what: 'Tailwind 默认调色板（令牌以外的颜色）',
    pattern:
      /\b(text|bg|border|ring|outline|fill|stroke|from|to|via|divide|accent|caret|decoration)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white)\b/,
  },
]

const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
const stripTsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, m => m.replace(/[^\n]/g, ' '))

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
  for (const name of ['--bg', '--panel', '--text', '--muted', '--line', '--hover', '--select']) {
    assert.match(light, new RegExp(`${name}:`), `亮色缺 ${name}`)
    assert.match(dark, new RegExp(`${name}:`), `暗色缺 ${name}`)
  }
  for (const name of [
    '--font-sans',
    '--font-mono',
    '--text-base',
    '--radius-md',
    '--spacing',
    '--color-primary',
    '--color-primary-foreground',
    '--color-muted-foreground',
    '--color-destructive',
    '--color-border',
    '--color-ring',
  ]) {
    assert.match(t, new RegExp(`${name}:`), `缺 ${name}`)
  }
})

test('样式入口不引入 preflight，现有页面的样式在组件和工具类之前的层', () => {
  const index = stripCssComments(readFileSync(join(WEB, 'index.css'), 'utf8'))
  assert.match(index, /@layer theme, base, legacy, components, utilities;/)
  assert.match(index, /@import "tailwindcss\/utilities\.css" layer\(utilities\);/)
  assert.match(index, /@import "\.\/styles\.css" layer\(legacy\);/)
  assert.doesNotMatch(index, /preflight|tailwindcss\/theme|@import "tailwindcss"/)
  assert.match(readFileSync(join(WEB, 'main.tsx'), 'utf8'), /import '\.\/index\.css'/)
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
  ]
  for (const line of tsx) assert.ok(violations('x.tsx', line).length > 0, line)
  const ok = [
    '.a { color: var(--text); border-radius: 50%; font: inherit; }',
    '/* #fff 13px */',
    '<a href="#/tasks/123">#123</a>',
    '<p className="text-sm text-muted-foreground p-2 rounded-md bg-primary" />',
    '<span style={{ paddingLeft: depth * 16 }} />',
  ]
  for (const line of ok) assert.deepEqual(violations(line.startsWith('<') ? 'x.tsx' : 'x.css', line), [], line)
})
