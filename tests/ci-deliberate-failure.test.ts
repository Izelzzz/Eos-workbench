// CI 故意失败的验证用，下一个提交会撤掉
import { test } from 'node:test'
import assert from 'node:assert/strict'
const n: number = 'CI 故意的类型错误'
test('CI 故意失败的测试', () => assert.equal(n, 1))
