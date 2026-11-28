// 基础组件（web/src/ui）：
// - 用到的每个 Tailwind 类都按令牌生成了样式。令牌里没有的值（例如没定义的字重、断点）Tailwind 不报错、只是不生成，这里把它查出来；
// - 不用和现有页面类名同名的工具类（例如 block、grow）：它们会作用到现有页面里同名的元素；
// - 组件渲染出的结构、状态和无障碍属性（服务端渲染，不需要浏览器）。
import { __unstable__loadDesignSystem } from '@tailwindcss/node'
import { Scanner } from '@tailwindcss/oxide'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createElement as h, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardTitle,
  cn,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableRow,
  Textarea,
} from '../web/src/ui/index.ts'

const WEB = join(import.meta.dirname, '..', 'web', 'src')
const UI = join(WEB, 'ui')
// 现有页面用的类名：styles.css 里的类选择器，和页面文件里 className 字符串中的词。
// 组件用到同名的工具类时，工具类会作用到现有页面里同名的元素
const legacyClasses = (): Set<string> => {
  const names = new Set(readFileSync(join(WEB, 'styles.css'), 'utf8').match(/(?<=\.)[a-z][\w-]*/g) ?? [])
  for (const f of readdirSync(WEB).filter(n => n.endsWith('.tsx'))) {
    const src = readFileSync(join(WEB, f), 'utf8')
    // className="…"、className={…} 里的所有字符串（含三元表达式的分支），以及表格式定义里的 cls: '…'
    const parts = [...src.matchAll(/className="([^"]*)"/g)].map(m => m[1]!)
    for (const m of src.matchAll(/className=\{([^}]*)\}/g)) parts.push(...[...m[1]!.matchAll(/['"`]([^'"`]*)['"`]/g)].map(s => s[1]!))
    parts.push(...[...src.matchAll(/\bcls:\s*'([^']*)'/g)].map(m => m[1]!))
    for (const w of parts.join(' ').split(/[\s$]+/)) if (/^[a-z][\w-]*$/.test(w)) names.add(w)
  }
  return names
}

test('组件里的每个 Tailwind 类都生成了样式（取值来自令牌）', async () => {
  const ds = await __unstable__loadDesignSystem(readFileSync(join(WEB, 'index.css'), 'utf8'), { base: WEB })
  const legacy = legacyClasses()
  assert.ok(
    ['block', 'pill', 'trace-row', 'active', 'p-agent'].every(n => legacy.has(n)),
    '没读到现有页面的类名',
  )
  const missing: string[] = []
  const collisions: string[] = []
  for (const f of readdirSync(UI).filter(n => n.endsWith('.tsx') || n.endsWith('.ts'))) {
    const candidates = new Scanner({}).scanFiles([{ content: readFileSync(join(UI, f), 'utf8'), extension: f.split('.').pop()! }])
    for (const c of candidates) {
      // 去掉变体前缀（hover:、sm:、data-[x]: 等）后，是 Tailwind 认得的工具类才算类名；data-slot、button 这类普通字符串跳过
      const utility = c.split(/:(?![^[]*\])/).at(-1)!
      const css = ds.candidatesToCss([c])[0]
      if (css != null) {
        if (legacy.has(c)) collisions.push(`${f}: ${c}`)
        continue
      }
      // 没生成样式的：只有根、没有值的普通单词（from、size、p）不是类名，跳过；带值的（font-light、sm:max-w-lg）是缺令牌
      const parsed = [...ds.parseCandidate(utility)] as { kind: string; value?: unknown }[]
      if (parsed.some(p => p.kind !== 'functional' || p.value != null)) missing.push(`${f}: ${c}`)
    }
  }
  assert.deepEqual(missing, [], '这些类没有生成样式：令牌里缺对应的值（加到 web/src/tokens.css），或者是写错的类名')
  assert.deepEqual(collisions, [], '这些工具类和现有页面的类名同名，会作用到现有页面里同名的元素：换一个写法（例如 flex-1 代替 grow）')
})

test('组件只经 index.ts 对外，页面不直接用 @base-ui/react', () => {
  const offenders = readdirSync(WEB)
    .filter(n => n.endsWith('.tsx') || n.endsWith('.ts'))
    .filter(n => /from '@base-ui\/react/.test(readFileSync(join(WEB, n), 'utf8')))
  assert.deepEqual(offenders, [])
})

test('cn：调用方的类覆盖组件默认的同类工具类，令牌字号不被当成颜色', () => {
  assert.equal(cn('p-2 text-sm', 'p-4'), 'text-sm p-4')
  assert.equal(cn('text-code text-ink-2'), 'text-code text-ink-2')
  assert.equal(cn('text-md', 'text-sm'), 'text-sm')
  assert.equal(cn('border-transparent', 'border-line'), 'border-line')
  // 令牌里另起了名字的字号、圆角、阴影：和颜色类不互相覆盖，和同类互相覆盖
  assert.equal(cn('text-lead text-ink-2'), 'text-lead text-ink-2')
  assert.equal(cn('text-title', 'text-control'), 'text-control')
  assert.equal(cn('rounded-control', 'rounded-card'), 'rounded-card')
  assert.equal(cn('shadow-card', 'shadow-popover'), 'shadow-popover')
  assert.equal(cn('shadow-card bg-surface'), 'shadow-card bg-surface')
})

test('Button：默认是主按钮，变体换样式，禁用时不可点，调用方的类追加在后面', () => {
  const primary = renderToStaticMarkup(h(Button, null, '保存'))
  assert.match(primary, /^<button type="button"/)
  assert.match(primary, /data-slot="button"/)
  assert.match(primary, /bg-ink text-surface/)
  const outline = renderToStaticMarkup(h(Button, { variant: 'outline', disabled: true, className: 'w-full' }, '取消'))
  assert.match(outline, / disabled=""/)
  assert.match(outline, /border-line bg-transparent/)
  assert.doesNotMatch(outline, /border-transparent/)
  assert.match(outline, /w-full"/)
  assert.match(renderToStaticMarkup(h(Button, { type: 'submit' }, '提交')), /type="submit"/)
})

test('Field：标签关联控件，错误有内容才显示并用 role="alert"', () => {
  const html = renderToStaticMarkup(
    h(
      Field,
      { 'data-invalid': true } as ComponentProps<typeof Field>,
      h(FieldLabel, { htmlFor: 'name' }, 'App 名字'),
      h(Input, { id: 'name', 'aria-invalid': true }),
      h(FieldDescription, null, '最多 34 个字符'),
      h(FieldError, null, '名字已被占用'),
    ),
  )
  assert.match(html, /^<div role="group" data-slot="field"[^>]*data-invalid="true"/)
  assert.match(html, /<label data-slot="field-label"[^>]*for="name"/)
  assert.match(html, /<input[^>]*id="name"[^>]*aria-invalid="true"/)
  assert.match(html, /<p role="alert" data-slot="field-error"[^>]*>名字已被占用<\/p>/)
  for (const empty of [undefined, null, false, '']) assert.equal(renderToStaticMarkup(h(FieldError, null, empty)), '')
})

test('Textarea、Select：和输入框同一套外观，Select 是原生下拉并带图标', () => {
  assert.match(renderToStaticMarkup(h(Textarea, { rows: 3 })), /<textarea data-slot="textarea"[^>]*rows="3"/)
  const select = renderToStaticMarkup(h(Select, { defaultValue: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B')))
  assert.match(select, /<select data-slot="select"[^>]*appearance-none/)
  assert.match(select, /<svg[^>]*aria-hidden="true"/)
})

test('Badge、Alert：状态变体用语义颜色，失败提示用 role="alert"，其余用 role="status"', () => {
  assert.match(renderToStaticMarkup(h(Badge, { variant: 'success' }, '完成')), /bg-success px-2 text-on-solid/)
  assert.match(renderToStaticMarkup(h(Badge, null, '推荐')), /bg-fill text-ink-2/)
  assert.match(renderToStaticMarkup(h(Badge, { variant: 'accent' }, '提问')), /bg-accent-soft text-accent/)
  assert.match(renderToStaticMarkup(h(Alert, { variant: 'destructive' }, '推送失败')), /role="alert"/)
  assert.match(renderToStaticMarkup(h(Alert, { variant: 'success' }, '已保存')), /role="status"/)
})

test('Card、Table：面板有标题层级，表格放在可横向滚动的容器里', () => {
  assert.match(renderToStaticMarkup(h(Card, null, h(CardTitle, null, '凭据'), h(CardContent, null, '…'))), /<section data-slot="card"[^>]*><h2 data-slot="card-title"/)
  const table = renderToStaticMarkup(h(Table, null, h(TableBody, null, h(TableRow, null, h(TableCell, null, '1')))))
  assert.match(table, /^<div data-slot="table-container" class="[^"]*overflow-x-auto/)
})
