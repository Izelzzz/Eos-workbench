// 页面外壳（web/src/shell）：地址对应导航里的哪一项、设置页的两段地址、导航渲染出的结构和无障碍属性。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NAV_FOOT, NAV_MAIN, Nav, navOf } from '../web/src/shell/Nav.tsx'
import { parseSettingsRoute } from '../web/src/shell/Settings.tsx'

test('导航：这一版没有「工作台」，上面五项、左下角「设置」', () => {
  assert.deepEqual(
    NAV_MAIN.map(n => n.label),
    ['对话', '任务', '统计', '改进', '团队约定'],
  )
  assert.deepEqual(
    NAV_FOOT.map(n => n.label),
    ['设置'],
  )
})

test('地址对应的导航项：子路径和查询串归到同一项，首页、新建、任务详情和不认识的地址算「任务」', () => {
  const cases: [string, string][] = [
    ['', 'tasks'],
    ['#/', 'tasks'],
    ['#/new', 'tasks'],
    ['#/tasks/t-1a2b', 'tasks'],
    ['#/chat', 'chats'],
    ['#/chat/c-1', 'chats'],
    ['#/insights', 'insights'],
    ['#/improve', 'improve'],
    ['#/improve/p-3', 'improve'],
    ['#/conventions', 'conventions'],
    ['#/conventions/doc/style', 'conventions'],
    ['#/credentials', 'settings'],
    ['#/forges', 'settings'],
    ['#/forges?registered=github-app&app=Eos', 'settings'],
    ['#/chatter', 'tasks'],
    ['#/nope', 'tasks'],
  ]
  for (const [hash, id] of cases) assert.equal(navOf(hash), id, hash)
  // 每一项自己的链接打开后，当前项就是它自己
  for (const n of [...NAV_MAIN, ...NAV_FOOT]) assert.equal(navOf(n.href), n.id, n.href)
})

test('设置页的地址：旧的 #/credentials、#/forges 是两段的地址，代码托管的查询串原样交给页面', () => {
  assert.deepEqual(parseSettingsRoute('#/credentials'), { tab: 'credentials', query: '' })
  assert.deepEqual(parseSettingsRoute('#/forges'), { tab: 'forges', query: '' })
  assert.deepEqual(parseSettingsRoute('#/forges?registered=github-app&app=Eos'), { tab: 'forges', query: 'registered=github-app&app=Eos' })
  assert.equal(parseSettingsRoute('#/'), undefined)
  assert.equal(parseSettingsRoute('#/forgesx'), undefined)
  assert.equal(parseSettingsRoute('#/credentials/x'), undefined)
})

test('导航渲染：每项是有名字的链接，当前页标 aria-current，名字的浮层对读屏隐藏', () => {
  const html = renderToStaticMarkup(h(Nav, { current: 'settings' }))
  assert.match(html, /^<nav aria-label="主导航"/)
  const links = [...html.matchAll(/<a [^>]*>/g)].map(m => m[0])
  assert.equal(links.length, 6)
  assert.deepEqual(
    links.map(a => /aria-label="([^"]*)"/.exec(a)?.[1]),
    ['对话', '任务', '统计', '改进', '团队约定', '设置'],
  )
  assert.deepEqual(
    links.filter(a => a.includes('aria-current="page"')).map(a => /href="([^"]*)"/.exec(a)?.[1]),
    ['#/credentials'],
  )
  assert.equal((html.match(/<span aria-hidden="true" class="pointer-events-none/g) ?? []).length, 6)
  // 小圆点只属于「工作台」：这一版导航里没有工作台，有等你处理的事也不显示
  assert.doesNotMatch(renderToStaticMarkup(h(Nav, { current: 'tasks', waiting: 3 })), /件等你处理|data-slot="accent-dot"/)
})
