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
  InfoList,
  InfoRow,
  Input,
  Note,
  Option,
  OptionGroup,
  OptionOther,
  type OptionAnswer,
  Segmented,
  SegmentedItem,
  SegmentedList,
  SegmentedPanel,
  Select,
  Steps,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TaskList,
  TaskRow,
  Textarea,
} from '../web/src/ui/index.ts'

const WEB = join(import.meta.dirname, '..', 'web', 'src')
const UI = join(WEB, 'ui')
// 用 Tailwind 的目录：从 index.css 的 @source 读，新加的目录自动进检查范围
const TAILWIND_DIRS = [...readFileSync(join(WEB, 'index.css'), 'utf8').matchAll(/^@source "\.\/([\w-]+)";$/gm)].map(m => join(WEB, m[1]!))
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

test('组件和页面外壳里的每个 Tailwind 类都生成了样式（取值来自令牌）', async () => {
  const ds = await __unstable__loadDesignSystem(readFileSync(join(WEB, 'index.css'), 'utf8'), { base: WEB })
  const legacy = legacyClasses()
  assert.ok(
    ['block', 'pill', 'trace-row', 'active', 'p-agent'].every(n => legacy.has(n)),
    '没读到现有页面的类名',
  )
  const missing: string[] = []
  const collisions: string[] = []
  const files = TAILWIND_DIRS.flatMap(d =>
    readdirSync(d)
      .filter(n => n.endsWith('.tsx') || n.endsWith('.ts'))
      .map(n => join(d, n)),
  )
  assert.ok(TAILWIND_DIRS.includes(UI) && TAILWIND_DIRS.length >= 2, '没读到 index.css 的 @source')
  for (const path of files) {
    const f = path.slice(WEB.length + 1)
    const candidates = new Scanner({}).scanFiles([{ content: readFileSync(path, 'utf8'), extension: f.split('.').pop()! }])
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

test('Option：原生单选，同组同 name；标题、说明、标签都在 label 里，勾是装饰；「其他」默认读作「其他」', () => {
  const html = renderToStaticMarkup(
    h(
      OptionGroup,
      { name: 'scope', legend: '导出时要不要包含已中止的任务？', defaultValue: { kind: 'option', value: 'all' } },
      h(Option, { value: 'all', title: '包含', description: '和列表页一致', badge: h(Badge, null, '推荐') }),
      h(Option, { value: 'none', title: '不包含' }),
      h(OptionOther, { placeholder: '其他…' }),
    ),
  )
  assert.match(html, /^<fieldset data-slot="option-group"[^>]*><legend[^>]*>导出时要不要包含已中止的任务？<\/legend>/)
  assert.equal((html.match(/<input type="radio"[^>]*name="scope"/g) ?? []).length, 2)
  assert.match(html, /<input type="radio"[^>]*name="scope"[^>]*checked=""[^>]*value="all"/)
  assert.match(html, /<label data-slot="option"[^>]*>.*包含.*推荐.*和列表页一致.*<\/label>/)
  assert.match(html, /<span aria-hidden="true" class="grid size-4\.5[^"]*border-tick border-line/)
  assert.match(html, /<input type="text" data-slot="option-other" aria-label="其他"[^>]*border-dashed[^>]*value=""/)
})

test('Option：答案只有一个，受控用法下也由组件保证（选项和「其他」互斥）', () => {
  const render = (value: OptionAnswer | undefined) =>
    renderToStaticMarkup(h(OptionGroup, { legend: 'q', value, onValueChange: () => {} }, h(Option, { value: 'a', title: 'A' }), h(Option, { value: 'b', title: 'B' }), h(OptionOther, {})))
  const picked = render({ kind: 'option', value: 'b' })
  assert.equal((picked.match(/checked=""/g) ?? []).length, 1)
  assert.match(picked, /checked="" value="b"/)
  assert.match(picked, /data-slot="option-other"[^>]*value=""/)
  const other = render({ kind: 'other', text: '都要' })
  assert.doesNotMatch(other, /checked=""/)
  assert.match(other, /data-slot="option-other"[^>]*value="都要"/)
  assert.doesNotMatch(render(undefined), /checked=""/)
  // 不放在 OptionGroup 里会直接报错，而不是悄悄失去互斥
  assert.throws(() => renderToStaticMarkup(h(Option, { value: 'a', title: 'A' })), /OptionGroup/)
})

test('Steps：当前步骤标 aria-current="step"，走过的有勾；不传 onSelect 时只是文字，传了是按钮', () => {
  const steps = [
    { key: 'scope', label: '范围', state: 'done' as const },
    { key: 'enc', label: '编码', state: 'current' as const },
    { key: 'sum', label: '汇总', state: 'todo' as const },
  ]
  const html = renderToStaticMarkup(h(Steps, { steps }))
  assert.match(html, /^<ol data-slot="steps"/)
  assert.equal((html.match(/<li/g) ?? []).length, 3)
  assert.doesNotMatch(html, /<button/)
  assert.match(html, /<span class="[^"]*"><svg[^>]*>.*?<\/svg>范围<\/span>/)
  assert.match(html, /<span aria-current="step"[^>]*>编码</)
  assert.equal((html.match(/aria-current/g) ?? []).length, 1)
  const clickable = renderToStaticMarkup(h(Steps, { steps, onSelect: () => {} }))
  assert.equal((clickable.match(/<button type="button"/g) ?? []).length, 3)
})

test('TaskRow：按工作流节点数分段，读屏读进度；等人处理时有强调色圆点、当前段和状态用强调色', () => {
  const waiting = renderToStaticMarkup(h(TaskList, null, h(TaskRow, { name: '导出任务列表为 CSV', state: '规格 · 等你回答', total: 5, done: 0, waiting: true })))
  assert.match(waiting, /data-waiting="true"/)
  assert.match(waiting, /data-slot="waiting-dot"/)
  assert.equal((waiting.match(/<i /g) ?? []).length, 5)
  assert.equal((waiting.match(/bg-accent"/g) ?? []).length, 2) // 圆点和当前那一段
  assert.match(waiting, /text-accent">规格 · 等你回答</)
  const running = renderToStaticMarkup(h(TaskList, null, h(TaskRow, { name: '升级 vite', state: '交付 · 正在推送', total: 5, done: 4, onSelect: () => {} })))
  assert.match(running, /<button type="button"/)
  assert.doesNotMatch(waiting, /<button/) // 没传 onSelect：只是文字
  // 超出范围的进度按边界算
  const over = renderToStaticMarkup(h(TaskList, null, h(TaskRow, { name: 'x', state: 'y', total: 5, done: 7 })))
  assert.equal((over.match(/bg-ink"/g) ?? []).length, 5)
  const under = renderToStaticMarkup(h(TaskList, null, h(TaskRow, { name: 'x', state: 'y', total: 5, done: -1 })))
  assert.equal((under.match(/bg-ink-3"/g) ?? []).length, 1)
  assert.doesNotMatch(running, /waiting-dot|bg-accent|text-accent/)
  assert.equal((running.match(/bg-ink"/g) ?? []).length, 4)
  assert.equal((running.match(/bg-ink-3"/g) ?? []).length, 1)
  assert.match(running, /<span class="sr-only">，进度 4 \/ 5<\/span>/)
  // 段数跟着工作流走：三个节点就是三段
  const three = renderToStaticMarkup(h(TaskList, null, h(TaskRow, { name: 'x', state: 'y', total: 3, done: 1 })))
  assert.equal((three.match(/<i /g) ?? []).length, 3)
  assert.match(three, /进度 1 \/ 3/)
  // 段数、进度不是有限数时按 1 段、0 段算，不读出 NaN
  const bad = renderToStaticMarkup(h(TaskList, null, h(TaskRow, { name: 'x', state: 'y', total: Number.NaN, done: Number.NaN })))
  assert.equal((bad.match(/<i /g) ?? []).length, 1)
  assert.match(bad, /进度 0 \/ 1/)
})

test('InfoRow、Note、Segmented：信息行是 dt/dd，说明块是浅底，分段切换是页签', () => {
  const info = renderToStaticMarkup(h(InfoList, null, h(InfoRow, { label: '改动', children: '6 个文件，+142 −18' })))
  assert.match(info, /^<dl data-slot="info-list"[^>]*><div data-slot="info-row"[^>]*><dt class="w-14[^"]*">改动<\/dt><dd[^>]*>6 个文件/)
  assert.match(renderToStaticMarkup(h(Note, null, '说明')), /^<div data-slot="note" class="rounded-box bg-fill/)
  const seg = renderToStaticMarkup(
    h(Segmented, { defaultValue: 'log' }, h(SegmentedList, null, h(SegmentedItem, { value: 'log' }, '过程'), h(SegmentedItem, { value: 'diff' }, '改动')), h(SegmentedPanel, { value: 'log' }, '…')),
  )
  assert.match(seg, /role="tablist"/)
  assert.match(seg, /role="tab"[^>]*aria-selected="true"[^>]*>过程</)
  assert.match(seg, /role="tab"[^>]*aria-selected="false"[^>]*>改动</)
})
