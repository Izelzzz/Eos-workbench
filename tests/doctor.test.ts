import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { atLeast, evaluate, formatItems, gather, type Facts } from '../src/runner/doctor.ts'

const ROOT = join(import.meta.dirname, '..')
const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = () => {
  const d = mkdtempSync(join(ROOT, 'node_modules', '.eos-doctor-'))
  dirs.push(d)
  return d
}
const good: Facts = { node: '24.10.0', nodeRequired: '>=24.9.0', modelKey: { source: 'credentials' }, masterKey: { kind: 'ok', id: '0123456789abcdef' }, git: { version: '2.43.0' }, sandbox: { backend: 'bwrap' }, dataDir: '/srv/eos', dsh: '0.2.2-rc.5' }

test('版本比较按主、次、修订号', () => {
  assert.equal(atLeast('24.9.0', '24.9.0'), true)
  assert.equal(atLeast('24.10.0', '24.9.0'), true)
  assert.equal(atLeast('v25.0.1', '24.9.0'), true)
  assert.equal(atLeast('22.23.5', '24.9.0'), false)
  assert.equal(atLeast('24.8.9', '24.9'), false)
})

test('环境都满足时每项都通过', () => {
  const items = evaluate(good)
  assert.deepEqual(items.map(i => [i.name, i.status]), [['Node', 'ok'], ['DeepSeek API key', 'ok'], ['凭据主密钥', 'ok'], ['沙箱', 'ok'], ['凭据隔离', 'warn'], ['git', 'ok'], ['数据目录', 'ok'], ['dsh', 'ok']])
})

test('Node 版本不够是 ⚠（只提示），其余不满足是 ✗；每项都写清怎么修', () => {
  const bad: Facts = { node: '22.23.5', nodeRequired: '>=24.9.0', modelKey: { source: 'missing' }, masterKey: { kind: 'invalid', error: 'EOS_MASTER_KEY 不是 base64 编码' }, git: { missing: true }, sandbox: { backend: 'none' }, dataDir: '/srv/eos', dataDirError: '没有写权限（EACCES）' }
  const items = evaluate(bad)
  assert.deepEqual(items.map(i => i.status), ['warn', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail'])
  assert.ok(items.every(i => i.fix !== undefined && i.fix !== ''), JSON.stringify(items))
  const text = formatItems(items)
  assert.match(text, /⚠ Node：22\.23\.5，低于 Eos 要求的 >=24\.9\.0.*；照常启动，但可能遇到兼容问题\n  怎么修：安装 Node 24\.9\.0/)
  assert.match(text, /✗ DeepSeek API key：凭据存储里没有 deepseek，也没有设置环境变量 DEEPSEEK_API_KEY\n  怎么修：在 Web 的「凭据」页添加名为 deepseek/)
  assert.match(text, /✗ 凭据主密钥：EOS_MASTER_KEY 不是 base64 编码\n  怎么修：生成一个主密钥：openssl rand -base64 32/)
  assert.match(text, /✗ git：找不到 git 命令/)
  assert.match(text, /✗ 数据目录：\/srv\/eos：没有写权限（EACCES）\n  怎么修：用 --data/)
  assert.match(text, /✗ dsh：没有安装，或安装不完整\n  怎么修：在仓库目录运行 npm install/)
  assert.match(text, /✗ 沙箱：bwrap 和 Landlock 都用不了：dsh 会拒绝执行命令\S*\n  怎么修：安装 bubblewrap/)
})

test('engines 读不出或写法认不出时给出提示；git 运行失败和找不到分开说', () => {
  assert.match(formatItems(evaluate({ ...good, nodeRequired: '>=24.9.0 <27' })), /⚠ Node：24\.10\.0；认不出 engines\.node 的写法「>=24\.9\.0 <27」/)
  const { nodeRequired: _dropped, ...noEngines } = good
  assert.match(formatItems(evaluate(noEngines)), /⚠ Node：24\.10\.0；读不出 Eos 的 package\.json 里的 engines\.node/)
  assert.match(formatItems(evaluate({ ...good, git: { error: 'permission denied' } })), /✗ git：git 运行失败：permission denied\n  怎么修：/)
})

test('没设置主密钥只提示（⚠），写明怎么生成；doctor 只显示指纹', () => {
  const text = formatItems(evaluate({ ...good, masterKey: { kind: 'missing' } }))
  assert.match(text, /⚠ 凭据主密钥：没有设置 EOS_MASTER_KEY，不能保存或读取凭据\n  怎么修：生成一个主密钥/)
  assert.match(formatItems(evaluate(good)), /✓ 凭据主密钥：已设置 EOS_MASTER_KEY（指纹 0123456789abcdef）/)
})

test('沙箱按实际生效的后端报告：bwrap、Landlock（完整 / 部分）、都不可用、非 Linux', () => {
  const sandbox = (s: Facts['sandbox']) => evaluate({ ...good, sandbox: s }).find(i => i.name === '沙箱')!
  assert.equal(sandbox({ backend: 'bwrap' }).status, 'ok')
  assert.match(sandbox({ backend: 'bwrap' }).detail, /^bwrap：.*单独的进程号空间和私有 \/tmp/)
  assert.equal(sandbox({ backend: 'landlock', enforcement: 'full' }).status, 'ok')
  assert.match(sandbox({ backend: 'landlock', enforcement: 'full' }).detail, /^Landlock（bwrap 用不了）.*读不到别的进程的环境.*各任务共用 \/tmp/)
  assert.equal(sandbox({ backend: 'landlock', enforcement: 'partial' }).status, 'warn')
  assert.equal(sandbox({ backend: 'none' }).status, 'fail', 'dsh refuses to run commands without a sandbox, so tasks cannot run')
  assert.equal(sandbox({ backend: 'platform', platform: 'darwin' }).status, 'ok', 'macOS and Windows are not probed and must not block startup')
})

test('设置了主密钥时如实说明谁能读到：有沙箱时 agent 读不到、检查命令读得到；没有沙箱时两者都读得到；没设置主密钥时不提示', () => {
  const isolation = (s: Facts['sandbox']) => formatItems(evaluate({ ...good, sandbox: s }).filter(i => i.name === '凭据隔离'))
  for (const s of [{ backend: 'bwrap' }, { backend: 'landlock', enforcement: 'full' }] as const) {
    assert.match(isolation(s), /^⚠ 凭据隔离：agent 在沙箱里读不到它们；检查命令（npm test 等）和平台是同一个用户、不在沙箱里，能读到平台进程环境里的主密钥，以及 dsh 进程环境里的模型 key\n  怎么修：用独立的用户运行检查命令和 agent（路线图第 3 项，还没有做完）/)
  }
  assert.match(isolation({ backend: 'none' }), /^⚠ 凭据隔离：没有可用的沙箱：agent 和检查命令都能读到/)
  assert.doesNotMatch(isolation({ backend: 'landlock', enforcement: 'full' }), /Docker 部署会这样做/, 'the fix must not claim the deployment already isolates users')
  assert.ok(!evaluate({ ...good, masterKey: { kind: 'missing' } }).some(i => i.name === '凭据隔离'))
})

test('模型 key 显示来源：凭据存储、环境变量；读不出来时是 ✗，不悄悄改用环境变量', () => {
  assert.match(formatItems(evaluate(good)), /✓ DeepSeek API key：来自凭据存储（凭据 deepseek）/)
  assert.match(formatItems(evaluate({ ...good, modelKey: { source: 'env' } })), /✓ DeepSeek API key：来自环境变量 DEEPSEEK_API_KEY（凭据存储里没有 deepseek）/)
  assert.match(formatItems(evaluate({ ...good, modelKey: { source: 'error', error: '凭据 deepseek 解密失败' } })), /✗ DeepSeek API key：凭据存储里的 deepseek 读不出来：凭据 deepseek 解密失败\n  怎么修：/)
})

test('gather：读 package.json 的 engines 和 dsh 版本；只记 key 的来源，不带值；数据目录建不出来时记下原因', () => {
  const f = gather({ root: ROOT, dataDir: join(tmp(), 'data'), modelKey: { source: 'credentials', value: 'sk-secret-value' }, masterKey: { kind: 'missing' } })
  assert.equal(f.nodeRequired, '>=24.9.0')
  assert.equal(f.node, process.versions.node)
  assert.deepEqual(f.modelKey, { source: 'credentials' })
  assert.ok(!JSON.stringify(f).includes('sk-secret-value'))
  assert.match(f.dsh ?? '', /^0\.2\.2/)
  assert.match('version' in f.git ? f.git.version : '', /^\d+\.\d+/)
  assert.equal(f.dataDirError, undefined)
  assert.ok(existsSync(f.dataDir), '和别的命令一样会建出数据目录')
  const file = join(tmp(), 'a-file')
  writeFileSync(file, '')
  const blocked = gather({ root: ROOT, dataDir: join(file, 'data'), modelKey: { source: 'missing' }, masterKey: { kind: 'missing' } })
  assert.deepEqual(blocked.modelKey, { source: 'missing' })
  assert.equal(blocked.dataDirError, '路径里有一段不是目录（是普通文件）（ENOTDIR）')
})

const KEY = Buffer.alloc(32, 7).toString('base64')

const cli = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })

test('eos doctor 逐项列出结果，有 ✗ 时退出码不为 0', () => {
  const data = join(tmp(), 'data')
  const r = cli(['doctor', '--data', data], {})
  assert.equal(r.status, 1)
  assert.match(r.stdout, new RegExp(`^Eos 环境检查（数据目录 ${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}）`))
  for (const name of ['Node', 'DeepSeek API key', '凭据主密钥', 'git', '数据目录', 'dsh']) assert.match(r.stdout, new RegExp(`[✓⚠✗] ${name}：`))
  assert.match(r.stdout, /✗ DeepSeek API key[\s\S]*怎么修/)
  const withKey = cli(['doctor', '--data', data], { DEEPSEEK_API_KEY: 'k' })
  assert.match(withKey.stdout, /✓ DeepSeek API key/)
  assert.equal(withKey.status, 0, '没有 ✗ 时退出码为 0（Node 版本不够只是 ⚠）')
})

test('主密钥格式不对时 doctor 报 ✗，输出里没有主密钥本身', () => {
  const bad = 'not*base64'
  const r = cli(['doctor', '--data', join(tmp(), 'data')], { DEEPSEEK_API_KEY: 'k', EOS_MASTER_KEY: bad })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /✗ 凭据主密钥：EOS_MASTER_KEY 不是 base64 编码/)
  const ok = cli(['doctor', '--data', join(tmp(), 'data')], { DEEPSEEK_API_KEY: 'k', EOS_MASTER_KEY: KEY })
  assert.match(ok.stdout, /✓ 凭据主密钥：已设置 EOS_MASTER_KEY（指纹 [0-9a-f]{16}）/)
  assert.ok(!ok.stdout.includes(KEY) && !ok.stderr.includes(KEY))
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

test('Node 版本不够时只提示，命令照常执行；版本够时不提示', () => {
  const r = cli(['run', '--repo', join(tmp(), 'not-there'), '--data', join(tmp(), 'data'), '需求'], { DEEPSEEK_API_KEY: 'k' })
  assert.doesNotMatch(r.stderr, /没有启动/)
  assert.match(r.stderr, /找不到目录/, '通过了启动检查，走到了创建任务')
  const old = !atLeast(process.versions.node, '24.9.0')
  if (old) assert.match(r.stderr, /^启动前检查有提示（照常启动）：\n⚠ Node：/)
  else assert.doesNotMatch(r.stderr, /启动前检查有提示/)
})

test('凭据主密钥没设置、凭据隔离的 ⚠ 只在 doctor 里列出，启动时不提示', () => {
  for (const env of [{ DEEPSEEK_API_KEY: 'k' }, { DEEPSEEK_API_KEY: 'k', EOS_MASTER_KEY: KEY }]) {
    const r = cli(['run', '--repo', join(tmp(), 'not-there'), '--data', join(tmp(), 'data'), '需求'], env)
    assert.doesNotMatch(r.stderr, /凭据主密钥|凭据隔离/)
    const d = cli(['doctor', '--data', join(tmp(), 'data')], env)
    assert.match(d.stdout, 'EOS_MASTER_KEY' in env ? /⚠ 凭据隔离/ : /⚠ 凭据主密钥/)
  }
})
