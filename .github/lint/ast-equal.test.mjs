// ast-equal.mjs 的测试：在临时 git 仓库里放「改之前」的文件并提交，再写「改之后」，看比对结果。
// 运行（仓库根目录）：node --test .github/lint/ast-equal.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ast-equal.mjs')

/** 每个 [文件名, 改之前, 改之后] 放进同一个临时仓库，返回脚本的退出码和输出 */
function run(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'ast-equal-'))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' })
  try {
    git('init', '-q')
    mkdirSync(join(dir, '.github/lint'), { recursive: true })
    symlinkSync(join(here, 'node_modules'), join(dir, '.github/lint/node_modules'))
    writeFileSync(join(dir, '.github/lint/package.json'), '{}')
    for (const [f, before] of cases) writeFileSync(join(dir, f), before)
    git('add', '.')
    git('commit', '-qm', 'base')
    for (const [f, , after] of cases) writeFileSync(join(dir, f), after)
    const r = spawnSync('node', [script, 'HEAD'], { cwd: dir, encoding: 'utf8' })
    return { code: r.status, out: r.stdout + r.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('只改格式：换行、引号、行尾逗号、分号、多余括号、对象键引号、JSX 换行，判为一致', () => {
  const r = run([
    ['a.ts', 'const a = { "x": 1, y: [1,2,3] };\nconst f = (x) => (x + 1);\n', 'const a = {\n  x: 1,\n  y: [1, 2, 3],\n}\nconst f = x => x + 1\n'],
    ['b.ts', 'let q = 1;\n(q as number).toFixed();\n', 'let q = 1\n;(q as number).toFixed()\n'],
    ['c.tsx', 'export const C = () => <p>a <b>x</b> c</p>\n', 'export const C = () => (\n  <p>\n    a <b>x</b> c\n  </p>\n)\n'],
    ['d.tsx', 'export const D = () => <p><span>a</span> <span>b</span></p>\n', "export const D = () => (\n  <p>\n    <span>a</span>{' '}\n    <span>b</span>\n  </p>\n)\n"],
  ])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /语法树一致 4 个/)
})

test('改了含义：每一种都要报出来', () => {
  const cases = [
    ['s.ts', "export const s = 'a'\n", "export const s = 'b'\n"],
    ['n.ts', 'export const n = 1\n', 'export const n = 2\n'],
    ['k.ts', 'const x = 1\nexport { x }\n', 'let x = 1\nexport { x }\n'],
    ['t.ts', "import type { A } from 'a'\nexport type B = A\n", "import { A } from 'a'\nexport type B = A\n"],
    ['h.ts', 'class B {}\nexport class A extends B {}\n', 'class B {}\nexport class A implements B {}\n'],
    ['o.ts', 'export type K<T> = keyof T\n', 'export type K<T> = readonly T[]\n'],
    ['e.ts', 'const x = 1\nexport = x\n', 'const x = 1\nexport default x\n'],
    ['c.ts', 'declare const a: { b: { c: 1 } } | undefined\nexport const y = (a?.b).c\n', 'declare const a: { b: { c: 1 } } | undefined\nexport const y = a?.b.c\n'],
    ['u.js', "('use strict')\nexport const z = 1\n", "'use strict'\nexport const z = 1\n"],
    ['j.tsx', 'export const J = () => <p>a b</p>\n', 'export const J = () => <p>ab</p>\n'],
    ['p.ts', 'export const p = (1 + 2) * 3\n', 'export const p = 1 + 2 * 3\n'],
  ]
  const r = run(cases)
  assert.equal(r.code, 1, r.out)
  for (const [f] of cases) assert.match(r.out, new RegExp(`不一致：${f.replace('.', '\\.')}`), `${f} 没被报出来\n${r.out}`)
})

test('含指令注释的文件不算证明了，列为需要人工核对', () => {
  const r = run([['d.ts', '// @ts-expect-error\nexport const z: number = "a"\n', 'export const z: number =\n  // @ts-expect-error\n  "a"\n']])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /需要人工核对.*d\.ts/)
})

test('模板字符串和 JSX 文本不打乱指令注释的识别；三斜线指令也算', () => {
  const r = run([
    ['m.ts', "const a = `${1}`\n// @ts-expect-error\nexport const z: number = 'a'\nconst t = `b`\n", "const a = `${1}`\nexport const z: number =\n  // @ts-expect-error\n  'a'\nconst t = `b`\n"],
    ['x.tsx', "export const P = () => <p>a/*</p>\n// @ts-expect-error\nexport const z: number = 'a'\n", "export const P = () => <p>a/*</p>\nexport const z: number =\n  // @ts-expect-error\n  'a'\n"],
    ['r.ts', '/// <reference types="node" />\nexport const i = 1\n', 'export const i = 1\n/// <reference types="node" />\n'],
  ])
  assert.equal(r.code, 1, r.out)
  for (const f of ['m.ts', 'x.tsx', 'r.ts']) assert.match(r.out, new RegExp(`需要人工核对.*${f.replace('.', '\\.')}`), `${f} 没被报出来\n${r.out}`)
})

test('JS 里 JSDoc 类型转换的括号不当成多余括号', () => {
  const r = run([['c.js', 'const y = 1\nexport const v = /** @type {number} */ (y)\n', 'const y = 1\nexport const v = /** @type {number} */ y\n']])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /不一致：c\.js/)
})

test('普通注释里提到指令的词不算指令', () => {
  const r = run([['c.ts', '// 不许用 eslint-disable 关规则\nexport const c = 1;\n', '// 不许用 eslint-disable 关规则\nexport const c = 1\n']])
  assert.equal(r.code, 0, r.out)
})
