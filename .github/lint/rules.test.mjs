// 架构规则的测试：用仓库的 eslint 配置检查放在不同路径下的代码片段。
// 运行（仓库根目录）：node --test .github/lint/rules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const root = fileURLToPath(new URL('../..', import.meta.url))
const eslint = new ESLint({ cwd: root, overrideConfigFile: fileURLToPath(new URL('eslint.config.mjs', import.meta.url)) })

/** 返回 code 放在 path 时报出的规则 id（去重、排序）。 */
async function rules(path, code) {
  const [result] = await eslint.lintText(code, { filePath: `${root}${path}` })
  return [...new Set(result.messages.map(m => m.ruleId ?? `fatal: ${m.message}`))].sort()
}
const restricted = ['no-restricted-imports']

test('纯逻辑目录：不许读写文件、访问网络、起子进程；node:path 这种纯计算可以', async () => {
  for (const mod of ['node:fs', 'fs', 'node:fs/promises', 'node:child_process', 'node:net', 'node:https', 'node:os', 'node:worker_threads']) {
    assert.deepEqual(await rules('src/engine/x.ts', `import * as m from '${mod}'\nexport const a = m\n`), restricted, mod)
    assert.deepEqual(await rules('src/workflow/x.ts', `import * as m from '${mod}'\nexport const a = m\n`), restricted, mod)
  }
  assert.deepEqual(await rules('src/engine/x.ts', `import { join } from 'node:path'\nexport const a = join('a', 'b')\n`), [])
  // 纯逻辑目录以外不限制
  assert.deepEqual(await rules('src/runner/x.ts', `import { readFileSync } from 'node:fs'\nexport const a = readFileSync\n`), [])
})

test('纯逻辑目录：不许读时钟、访问网络、碰进程的全局', async () => {
  for (const expr of ['Date.now()', 'new Date()', 'performance.now()', "fetch('x')", 'process.env.X', 'setTimeout(() => {}, 1)']) {
    assert.deepEqual(await rules('src/engine/x.ts', `export const a = () => ${expr}\n`), ['no-restricted-globals'], expr)
  }
  assert.deepEqual(await rules('src/runner/x.ts', 'export const a = () => Date.now()\n'), [])
})

test('dsh 的包和客户端只在 src/executor/dsh.ts 里用', async () => {
  const dsh = `import { x } from '@deepseek-ai/dsh-session'\nexport const a = x\n`
  const vendor = `import { x } from '../../vendor/dsh-sdk-client/index.ts'\nexport const a = x\n`
  assert.deepEqual(await rules('src/executor/dsh.ts', dsh), [])
  assert.deepEqual(await rules('src/executor/dsh.ts', vendor), [])
  for (const path of ['src/runner/x.ts', 'src/web/x.ts', 'src/executor/other.ts', 'src/cli.ts', 'src/engine/x.ts', 'web/src/x.tsx', 'src/runner/doctor.ts']) {
    assert.deepEqual(await rules(path, dsh), restricted, `${path} @deepseek-ai`)
    assert.deepEqual(await rules(path, vendor), restricted, `${path} vendor`)
  }
})

test('执行器的实现只被 src/executor/ 和 src/cli.ts 引用；别处只认 types.ts', async () => {
  const impl = `import { DshExecutor } from '../executor/dsh.ts'\nexport const a = DshExecutor\n`
  const types = `import type { Executor } from '../executor/types.ts'\nexport type A = Executor\n`
  assert.deepEqual(await rules('src/runner/x.ts', impl), restricted)
  assert.deepEqual(await rules('src/engine/x.ts', impl), restricted)
  assert.deepEqual(await rules('src/runner/x.ts', types), [])
  assert.deepEqual(await rules('src/cli.ts', `import { DshExecutor } from './executor/dsh.ts'\nexport const a = DshExecutor\n`), [])
  assert.deepEqual(await rules('src/executor/other.ts', `import { DshExecutor } from './dsh.ts'\nexport const a = DshExecutor\n`), [])
})

test('例外只放开那一条：doctor.ts 能引用 dsh.ts 但不能直接用 @deepseek-ai；templates.ts 能读文件但不能起子进程、读时钟', async () => {
  assert.deepEqual(await rules('src/runner/doctor.ts', `import { dshInstall } from '../executor/dsh.ts'\nexport const a = dshInstall\n`), [])
  assert.deepEqual(await rules('src/workflow/templates.ts', `import { readFileSync } from 'node:fs'\nexport const a = readFileSync\n`), [])
  assert.deepEqual(await rules('src/workflow/templates.ts', `import { spawn } from 'node:child_process'\nexport const a = spawn\n`), restricted)
  assert.deepEqual(await rules('src/workflow/templates.ts', 'export const a = () => Date.now()\n'), ['no-restricted-globals'])
})

test('通用规则：src/ 里不许 any 和未使用的变量；测试和脚本里允许 any', async () => {
  assert.deepEqual(await rules('src/runner/x.ts', 'export const a = (x: any) => x\n'), ['@typescript-eslint/no-explicit-any'])
  assert.deepEqual(await rules('src/runner/x.ts', 'const unused = 1\nexport const a = 2\n'), ['@typescript-eslint/no-unused-vars'])
  assert.deepEqual(await rules('src/runner/x.ts', 'export const a = (_x: number) => 1\n'), [])
  assert.deepEqual(await rules('tests/x.test.ts', 'export const a = (x: any) => x\n'), [])
})

test('纯逻辑目录：数据库、虚拟机、联网的 npm 包也不许；动态 import() 和 globalThis 绕不过去', async () => {
  for (const mod of ['node:sqlite', 'node:vm', 'node:module', 'undici', 'ws']) {
    assert.deepEqual(await rules('src/engine/x.ts', `import * as m from '${mod}'\nexport const a = m\n`), restricted, mod)
  }
  assert.deepEqual(await rules('src/engine/x.ts', "export const a = () => import('node:fs')\n"), ['no-restricted-syntax'])
  for (const expr of ['globalThis.Date.now()', 'globalThis.process.env.X', "globalThis.fetch('x')"]) {
    // 现在 globalThis 本身也禁了，所以两条规则都报
    assert.deepEqual(await rules('src/engine/x.ts', `export const a = () => ${expr}\n`), ['no-restricted-globals', 'no-restricted-properties'], expr)
  }
  // 纯逻辑目录以外照常
  assert.deepEqual(await rules('src/runner/x.ts', "export const a = () => import('node:fs')\n"), [])
})

test('执行器规则：子目录和直接导入目录也拦；types 带 .js 扩展名也放行；名字里带 executor 的别的模块不受影响', async () => {
  for (const spec of ['../executor/dsh/impl.ts', '../executor', '../executor/', '../executor/index.ts']) {
    assert.deepEqual(await rules('src/runner/x.ts', `import * as e from '${spec}'\nexport const a = e\n`), restricted, spec)
  }
  for (const spec of ['../executor/types.ts', '../executor/types.js', '../executor/types']) {
    assert.deepEqual(await rules('src/runner/x.ts', `import type { Executor } from '${spec}'\nexport type A = Executor\n`), [], spec)
  }
  assert.deepEqual(await rules('src/runner/x.ts', `import * as e from './executor-utils.ts'\nexport const a = e\n`), [])
})

test('.cts 和 .cjs 文件也检查', async () => {
  assert.deepEqual(await rules('src/engine/x.cts', `import * as m from 'node:fs'\nexport const a = m\n`), restricted)
  assert.deepEqual(await rules('src/runner/x.cjs', 'const unused = 1\nexport const a = 2\n'), ['@typescript-eslint/no-unused-vars'])
})

test('行内注释关不掉规则：eslint-disable 本身就报错', async () => {
  const r = await rules('src/engine/x.ts', "// eslint-disable-next-line no-restricted-imports\nimport * as fs from 'node:fs'\nexport const a = fs\n")
  assert.ok(r.includes('no-restricted-imports'), r.join())
  const all = await rules('src/engine/x.ts', '/* eslint-disable */\nexport const a = () => Date.now()\n')
  assert.ok(all.includes('no-restricted-globals'), all.join())
})

test('纯逻辑目录只能导入这两个目录里的模块，不能借别的模块间接做 I/O', async () => {
  assert.deepEqual(await rules('src/engine/x.ts', "import { readFileSync } from '../store/fsutil.ts'\nexport const a = readFileSync\n"), restricted)
  assert.deepEqual(await rules('src/workflow/x.ts', "import * as v from '../../vendor/x.ts'\nexport const a = v\n"), restricted)
  assert.deepEqual(await rules('src/workflow/templates.ts', "import * as s from '../store/fsutil.ts'\nexport const a = s\n"), restricted)
  assert.deepEqual(await rules('src/engine/x.ts', "import type { T } from '../workflow/types.ts'\nimport { y } from './y.ts'\nexport const a: T = y\n"), [])
  assert.deepEqual(await rules('src/workflow/x.ts', "import { z } from 'zod'\nimport { parse } from 'yaml'\nexport const a = [z, parse]\n"), [])
})

test('其他目录用动态 import() 引执行器实现或 dsh 的包也拦', async () => {
  assert.deepEqual(await rules('src/runner/x.ts', "export const a = () => import('../executor/dsh.ts')\n"), ['no-restricted-syntax'])
  assert.deepEqual(await rules('src/runner/x.ts', "export const a = () => import('@deepseek-ai/dsh-session')\n"), ['no-restricted-syntax'])
  assert.deepEqual(await rules('src/runner/x.ts', "export const a = () => import('../executor/types.ts')\n"), [])
  assert.deepEqual(await rules('src/runner/x.ts', "export const a = () => import('node:fs')\n"), [])
})

test('纯逻辑目录不许用 globalThis，也不许 tty、async_hooks、crypto', async () => {
  assert.deepEqual(await rules('src/engine/x.ts', 'const g = globalThis\nexport const a = () => g\n'), ['no-restricted-globals'])
  for (const mod of ['node:tty', 'node:async_hooks', 'node:crypto']) {
    assert.deepEqual(await rules('src/engine/x.ts', `import * as m from '${mod}'\nexport const a = m\n`), restricted, mod)
  }
})
