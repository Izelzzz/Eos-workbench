import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { atLeast, evaluate, formatItems, gather, type Facts } from '../src/runner/doctor.ts'

const ROOT = join(import.meta.dirname, '..')
const tmp = () => mkdtempSync(join(ROOT, 'node_modules', '.eos-doctor-'))
const good: Facts = { node: '24.10.0', nodeRequired: '>=24.9.0', apiKey: true, git: { version: '2.43.0' }, dataDir: '/srv/eos', dsh: '0.2.2-rc.5' }

test('版本比较按主、次、修订号', () => {
  assert.equal(atLeast('24.9.0', '24.9.0'), true)
  assert.equal(atLeast('24.10.0', '24.9.0'), true)
  assert.equal(atLeast('v25.0.1', '24.9.0'), true)
  assert.equal(atLeast('22.23.5', '24.9.0'), false)
  assert.equal(atLeast('24.8.9', '24.9'), false)
})

test('环境都满足时每项都通过', () => {
  const items = evaluate(good)
  assert.deepEqual(items.map(i => [i.name, i.ok]), [['Node', true], ['DeepSeek API key', true], ['git', true], ['数据目录', true], ['dsh', true]])
})

test('每一项不满足时都是 ✗，并写清怎么修', () => {
  const bad: Facts = { node: '22.23.5', nodeRequired: '>=24.9.0', apiKey: false, git: { missing: true }, dataDir: '/srv/eos', dataDirError: '没有写权限（EACCES）' }
  const items = evaluate(bad)
  assert.ok(items.every(i => !i.ok && i.fix !== undefined && i.fix !== ''), JSON.stringify(items))
  const text = formatItems(items)
  assert.match(text, /✗ Node：22\.23\.5，低于 Eos 要求的 >=24\.9\.0[\s\S]*怎么修：安装 Node 24\.9\.0/)
  assert.match(text, /✗ DeepSeek API key：没有设置环境变量 DEEPSEEK_API_KEY\n  怎么修：/)
  assert.match(text, /✗ git：找不到 git 命令/)
  assert.match(text, /✗ 数据目录：\/srv\/eos：没有写权限（EACCES）\n  怎么修：用 --data/)
  assert.match(text, /✗ dsh：没有安装，或安装不完整\n  怎么修：在仓库目录运行 npm install/)
})

test('engines 读不出或写法认不出时不放行；git 运行失败和找不到分开说', () => {
  assert.match(formatItems(evaluate({ ...good, nodeRequired: '>=24.9.0 <27' })), /✗ Node：24\.10\.0；认不出 engines\.node 的写法「>=24\.9\.0 <27」/)
  const { nodeRequired: _dropped, ...noEngines } = good
  assert.match(formatItems(evaluate(noEngines)), /✗ Node：24\.10\.0；读不出 Eos 的 package\.json 里的 engines\.node/)
  assert.match(formatItems(evaluate({ ...good, git: { error: 'permission denied' } })), /✗ git：git 运行失败：permission denied\n  怎么修：/)
})

test('gather：读 package.json 的 engines 和 dsh 版本；只看 key 有没有设置；数据目录建不出来时记下原因', () => {
  const f = gather({ root: ROOT, dataDir: join(tmp(), 'data'), env: { DEEPSEEK_API_KEY: ' ' } })
  assert.equal(f.nodeRequired, '>=24.9.0')
  assert.equal(f.node, process.versions.node)
  assert.equal(f.apiKey, false, '空白不算设置')
  assert.match(f.dsh ?? '', /^0\.2\.2/)
  assert.match('version' in f.git ? f.git.version : '', /^\d+\.\d+/)
  assert.equal(f.dataDirError, undefined)
  assert.ok(existsSync(f.dataDir), '和别的命令一样会建出数据目录')
  const file = join(tmp(), 'a-file')
  writeFileSync(file, '')
  const blocked = gather({ root: ROOT, dataDir: join(file, 'data'), env: { DEEPSEEK_API_KEY: 'k' } })
  assert.equal(blocked.apiKey, true)
  assert.equal(blocked.dataDirError, '路径里有一段不是目录（是普通文件）（ENOTDIR）')
})

const cli = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })

test('eos doctor 逐项列出结果，有 ✗ 时退出码不为 0', () => {
  const data = join(tmp(), 'data')
  const r = cli(['doctor', '--data', data], {})
  assert.equal(r.status, 1)
  assert.match(r.stdout, new RegExp(`^Eos 环境检查（数据目录 ${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}）`))
  for (const name of ['Node', 'DeepSeek API key', 'git', '数据目录', 'dsh']) assert.match(r.stdout, new RegExp(`[✓✗] ${name}：`))
  assert.match(r.stdout, /✗ DeepSeek API key[\s\S]*怎么修/)
  assert.match(cli(['doctor', '--data', data], { DEEPSEEK_API_KEY: 'k' }).stdout, /✓ DeepSeek API key/)
})

test('doctor --help 显示帮助，不跑检查', () => {
  const r = cli(['doctor', '--help'], {})
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^用法：[\s\S]*eos doctor/)
})

test('会调用模型的命令启动前检查环境，不通过就不启动，也不打开数据库', () => {
  for (const cmd of [['run', '--repo', '.', '需求'], ['resume', 'x'], ['retry', 'x'], ['improve'], ['web']]) {
    const data = join(tmp(), 'data')
    const r = cli([...cmd, '--data', data], {})
    assert.equal(r.status, 1, cmd[0])
    assert.match(r.stderr, /^启动前检查没有通过，没有启动：\n[\s\S]*✗ DeepSeek API key[\s\S]*全部检查：npm run eos -- doctor/, cmd[0])
    assert.equal(existsSync(join(data, 'eos.db')), false, cmd[0])
  }
})

test('不调用模型的命令不做启动检查', () => {
  const r = cli(['status', '--data', join(tmp(), 'data')], {})
  assert.equal(r.status, 0)
  assert.match(r.stdout, /还没有任务/)
})
