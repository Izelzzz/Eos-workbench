// 平台持有的验收测试：在任务的 worktree 里运行（cwd），开发看不到这个文件。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
const { parseDuration } = await import(pathToFileURL(join(process.cwd(), 'src', 'duration.js')).href)
test('组合单位', () => assert.equal(parseDuration('1h30m'), 5400))
test('单个单位', () => { assert.equal(parseDuration('45s'), 45); assert.equal(parseDuration('2h'), 7200) })
test('三个单位', () => assert.equal(parseDuration('1h2m3s'), 3723))
test('小数（Go 的写法支持）', () => assert.equal(parseDuration('1.5h'), 5400))
test('单位大小写都可以（需求里没写，验收测试才有）', () => assert.equal(parseDuration('1H30M'), 5400))
test('非法输入抛 RangeError', () => { for (const s of ['', '10x', 'h', '1h30']) assert.throws(() => parseDuration(s), RangeError, JSON.stringify(s)) })
