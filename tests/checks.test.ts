import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { headings, missingSections, OUTPUT_TAIL, runChecks } from '../src/runner/checks.ts'

const worktree = () => mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-checks-'))

test('headings ignore # inside fenced code, and a section matches a numbered heading', () => {
  const md = '# 规格\n\n## 1. 背景与目标\n\n```bash\n# 这不是标题\n```\n\n### 验收标准 ###\n'
  assert.deepEqual(headings(md), ['规格', '1. 背景与目标', '验收标准'])
  assert.deepEqual(missingSections(md, ['背景', '验收标准', '测试要点']), ['测试要点'])
})

test('a file check reports a missing file, missing sections with the headings that exist, and passes when complete', async () => {
  const w = worktree()
  const check = { kind: 'file' as const, path: 'docs/spec.md', sections: ['背景', '验收标准'] }
  const [missing] = await runChecks(w, [check])
  assert.deepEqual(missing, { check, passed: false, detail: '文件 docs/spec.md 不存在' })
  mkdirSync(join(w, 'docs'))
  writeFileSync(join(w, 'docs/spec.md'), '# 规格\n## 背景\n')
  const [partial] = await runChecks(w, [check])
  assert.equal(partial?.passed, false)
  assert.match(partial!.detail, /缺少章节：验收标准\n现有标题：规格、背景/)
  writeFileSync(join(w, 'docs/spec.md'), '# 规格\n## 背景\n## 验收标准\n')
  assert.equal((await runChecks(w, [check]))[0]?.passed, true)
})

test('a deliverable that is a symlink out of the worktree does not pass', async () => {
  const w = worktree()
  const outside = join(worktree(), 'secret.md')
  writeFileSync(outside, '# 背景\n')
  symlinkSync(outside, join(w, 'spec.md'))
  const [r] = await runChecks(w, [{ kind: 'file', path: 'spec.md', sections: [] }])
  assert.equal(r?.passed, false)
  assert.match(r!.detail, /指向 worktree 外面/)
})

test('a command check runs in the worktree, reports the exit code and output tail, and every check runs even after a failure', async () => {
  const w = worktree()
  writeFileSync(join(w, 'fail.js'), `console.log('x'.repeat(${OUTPUT_TAIL * 3})); console.error('expected 3, got 4'); process.exit(2)`)
  const [fail, pass] = await runChecks(w, [
    { kind: 'run', run: [process.execPath, 'fail.js'], timeoutSec: 30 },
    { kind: 'run', run: [process.execPath, '-e', "require('fs').statSync('fail.js')"], timeoutSec: 30 },
  ])
  assert.equal(fail?.passed, false)
  assert.match(fail!.detail, /^退出码 2。输出：\n…（前面省略 \d+ 个字符）/)
  assert.match(fail!.detail, /expected 3, got 4$/)
  assert.ok(fail!.detail.length < OUTPUT_TAIL + 200)
  assert.deepEqual(pass, { check: { kind: 'run', run: [process.execPath, '-e', "require('fs').statSync('fail.js')"], timeoutSec: 30 }, passed: true, detail: '' })
})

test('a command that hangs is killed at its timeout, children included', async () => {
  const w = worktree()
  const started = Date.now()
  const [r] = await runChecks(w, [{ kind: 'run', run: ['sh', '-c', 'sleep 30 & sleep 30'], timeoutSec: 1 }])
  assert.equal(r?.passed, false)
  assert.match(r!.detail, /超过 1 秒没有结束，已终止/)
  assert.ok(Date.now() - started < 10_000)
})

test('commands get a minimal environment: no model keys, CI=1', async () => {
  const w = worktree()
  const env = { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'sk-secret', HOME: '/home/x' }
  const [r] = await runChecks(w, [{ kind: 'run', run: ['sh', '-c', 'test -z "$DEEPSEEK_API_KEY" && test "$CI" = 1 && test "$HOME" = /home/x'], timeoutSec: 10 }], env)
  assert.equal(r?.passed, true, r?.detail)
  const [missing] = await runChecks(w, [{ kind: 'run', run: ['no-such-command-eos'], timeoutSec: 10 }])
  assert.match(missing!.detail, /无法启动命令/)
})

test('a missing worktree is an error, not a failed check', async () => {
  await assert.rejects(runChecks('/nonexistent/eos-worktree', []), /worktree 不存在/)
})
