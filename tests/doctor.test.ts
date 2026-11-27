import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { ModelKey } from '../src/credentials/model-key.ts'
import { dshFacts, dshHealth, type DshFacts } from '../src/executor/dsh.ts'
import type { ExecutorContext } from '../src/executor/types.ts'
import { atLeast, evaluate, formatItems, gather, type Facts } from '../src/runner/doctor.ts'

const ROOT = join(import.meta.dirname, '..')
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(ROOT, 'node_modules', '.eos-doctor-'))
  dirs.push(d)
  return d
}
const goodDsh: DshFacts = { install: { version: '0.2.2-rc.5' }, sandbox: { backend: 'bwrap' }, modelKey: { source: 'credentials' } }
/** 平台的事实加上 dsh 的自检（dsh 的事实改掉其中几项）。 */
const withDsh = (d: Partial<DshFacts>, f: Omit<Facts, 'executors'>): Facts => ({ ...f, executors: [{ name: 'dsh', health: dshHealth({ ...goodDsh, ...d }) }] })
const platform: Omit<Facts, 'executors'> = {
  node: '24.10.0',
  nodeRequired: '>=24.9.0',
  masterKey: { kind: 'ok', id: '0123456789abcdef' },
  git: { version: '2.43.0' },
  dataDir: '/srv/eos',
  checkUser: { kind: 'none' },
  agentUser: { kind: 'none' },
  droppedProxies: [],
}
const good: Facts = withDsh({}, platform)
/** 只测平台那几项时，gather 不带执行器的自检。 */
const noExecutors: Facts['executors'] = []
const ctx = (modelKey: ModelKey, env: NodeJS.ProcessEnv = {}): ExecutorContext => ({ root: ROOT, dataDir: tmp(), env, modelKey: () => modelKey })

test('版本比较按主、次、修订号', () => {
  assert.equal(atLeast('24.9.0', '24.9.0'), true)
  assert.equal(atLeast('24.10.0', '24.9.0'), true)
  assert.equal(atLeast('v25.0.1', '24.9.0'), true)
  assert.equal(atLeast('22.23.5', '24.9.0'), false)
  assert.equal(atLeast('24.8.9', '24.9'), false)
})

test('环境都满足时每项都通过', () => {
  const items = evaluate(good)
  assert.deepEqual(
    items.map(i => [i.name, i.status]),
    [
      ['Node', 'ok'],
      ['DeepSeek API key', 'ok'],
      ['沙箱', 'ok'],
      ['dsh', 'ok'],
      ['凭据主密钥', 'ok'],
      ['凭据隔离', 'warn'],
      ['git', 'ok'],
      ['数据目录', 'ok'],
    ],
  )
})

test('Node 版本不够是 ⚠（只提示），其余不满足是 ✗；每项都写清怎么修', () => {
  const bad: Facts = withDsh(
    { modelKey: { source: 'missing' }, sandbox: { backend: 'none' }, install: { missing: true } },
    {
      node: '22.23.5',
      nodeRequired: '>=24.9.0',
      masterKey: { kind: 'invalid', error: 'EOS_MASTER_KEY 不是 base64 编码' },
      git: { missing: true },
      dataDir: '/srv/eos',
      dataDirError: '没有写权限（EACCES）',
      checkUser: { kind: 'fail', error: 'EOS_CHECK_USER=eos-check，但系统里没有这个用户' },
      agentUser: { kind: 'none' },
      droppedProxies: [],
    },
  )
  const items = evaluate(bad)
  assert.deepEqual(
    items.map(i => i.status),
    ['warn', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail'],
  )
  assert.ok(
    items.every(i => i.fix !== undefined && i.fix !== ''),
    JSON.stringify(items),
  )
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
  const sandbox = (s: DshFacts['sandbox']) => evaluate(withDsh({ sandbox: s }, platform)).find(i => i.name === '沙箱')!
  assert.equal(sandbox({ backend: 'bwrap' }).status, 'ok')
  assert.match(sandbox({ backend: 'bwrap' }).detail, /^bwrap：.*单独的进程号空间里；能写的 agent 有私有的 \/tmp，只读的 agent 看到的是共用的 \/tmp/)
  assert.equal(sandbox({ backend: 'landlock', enforcement: 'full' }).status, 'ok')
  assert.match(
    sandbox({ backend: 'landlock', enforcement: 'full' }).detail,
    /^Landlock（bwrap 用不了）：能写的 agent 只能写自己的 worktree 和 \/tmp，只读的 agent 什么都写不了；agent 读不到别的进程的环境.*各任务共用 \/tmp/,
  )
  assert.equal(sandbox({ backend: 'landlock', enforcement: 'partial' }).status, 'warn')
  assert.equal(sandbox({ backend: 'none' }).status, 'fail', 'dsh refuses to run commands without a sandbox, so tasks cannot run')
  assert.equal(sandbox({ backend: 'platform', platform: 'darwin' }).status, 'ok', 'macOS and Windows are not probed and must not block startup')
})

const isolationOf = (f: Facts) => formatItems(evaluate(f).filter(i => i.name === '凭据隔离'))

test('设置了主密钥时如实说明谁能读到；没有独立用户时是 ⚠；没设置主密钥时不提示', () => {
  const isolation = (s: DshFacts['sandbox']) => formatItems(evaluate(withDsh({ sandbox: s }, platform)).filter(i => i.name === '凭据隔离'))
  for (const s of [{ backend: 'bwrap' }, { backend: 'landlock', enforcement: 'full' }] as const) {
    assert.match(
      isolation(s),
      /^⚠ 凭据隔离：agent 和平台是同一个用户，读不到主密钥只靠沙箱挡住；agent 和 dsh 是同一个用户，读不到 dsh 进程环境里的模型 key 靠沙箱挡住；检查命令（npm test 等）和平台是同一个用户、不在沙箱里，主密钥和模型 key 都能读到\n  怎么修：用独立的用户运行检查命令和 agent/,
    )
  }
  assert.match(isolation({ backend: 'none' }), /^⚠ 凭据隔离：没有可用的沙箱，agent 和平台是同一个用户，能读到主密钥；没有可用的沙箱，agent 能读到 dsh 进程环境里的模型 key；检查命令/)
  assert.ok(!evaluate({ ...good, masterKey: { kind: 'missing' } }).some(i => i.name === '凭据隔离'))
  assert.match(isolationOf({ ...good, executors: [] }), /没有可用的沙箱/, '没有执行器报告时不当作有沙箱')
})

test('检查命令和 agent 都换了用户、沙箱可用时凭据隔离是 ✓；只换了检查命令时仍是 ⚠；用户设置错了或切换不过去是 ✗，拦下启动', () => {
  const users: Omit<Facts, 'executors'> = { ...platform, checkUser: { kind: 'ok', name: 'eos-check' }, agentUser: { kind: 'ok', name: 'eos-agent' } }
  const both: Facts = withDsh({ sandbox: { backend: 'landlock', enforcement: 'full' } }, users)
  const text = formatItems(evaluate(both))
  assert.match(text, /✓ 检查命令的用户：检查命令以 eos-check 运行，没有任何特权，读不到平台和 dsh 进程的环境/)
  assert.match(text, /✓ agent 的用户：dsh 和 agent 以 eos-agent 运行，没有任何特权，读不到平台进程的环境/)
  assert.match(
    text,
    /✓ 凭据隔离：agent 以 eos-agent 运行，读不到平台进程环境里的主密钥；agent 和 dsh 是同一个用户，读不到 dsh 进程环境里的模型 key 靠沙箱挡住；检查命令以 eos-check 运行，主密钥和模型 key 都读不到/,
  )
  const checkOnly = evaluate({ ...both, agentUser: { kind: 'none' } }).find(i => i.name === '凭据隔离')
  assert.equal(checkOnly?.status, 'warn')
  assert.equal(evaluate(withDsh({ sandbox: { backend: 'none' } }, users)).find(i => i.name === '凭据隔离')?.status, 'warn', '没有沙箱时 agent 能读到 dsh 的模型 key')
  for (const [field, name, caps] of [
    ['checkUser', '检查命令的用户', /SETUID、SETGID/],
    ['agentUser', 'agent 的用户', /SETUID、SETGID、KILL/],
  ] as const) {
    const failed = evaluate({ ...both, [field]: { kind: 'fail', error: '切换不到：setpriv: setresuid failed: Operation not permitted' } }).find(i => i.name === name)
    assert.equal(failed?.status, 'fail', name)
    assert.match(failed?.fix ?? '', caps)
    assert.ok(!evaluate(good).some(i => i.name === name), `${name}：没有设置时不列出`)
  }
})

test('gather：设置了 agent 的用户但没有设置 dsh 的入口时是 ✗（dsh 不会切换用户），而不是误报已隔离', () => {
  const launcher = process.env.EOS_DSH_LAUNCHER
  delete process.env.EOS_DSH_LAUNCHER
  try {
    const f = gather({
      root: ROOT,
      dataDir: join(tmp(), 'data'),
      executors: noExecutors,
      masterKey: { kind: 'missing' },
      checkUser: { kind: 'none' },
      agentUser: { kind: 'ok', user: { name: process.env.USER ?? 'root', gid: 0, home: '/tmp' } },
    })
    // 本机没有切换用户的能力时先报切换不过去；有能力（root）时报没有入口。两种都是 ✗。
    assert.equal(f.agentUser.kind, 'fail')
    if (process.getuid?.() === 0) assert.match(f.agentUser.kind === 'fail' ? f.agentUser.error : '', /没有设置 EOS_DSH_LAUNCHER/)
  } finally {
    if (launcher !== undefined) process.env.EOS_DSH_LAUNCHER = launcher
  }
})

test('代理地址带账号密码、没有传给检查命令时提示', () => {
  const item = evaluate({ ...good, droppedProxies: ['HTTPS_PROXY'] }).find(i => i.name === '检查命令的代理')
  assert.equal(item?.status, 'warn')
  assert.match(item?.detail ?? '', /HTTPS_PROXY 带账号密码，没有传给检查命令/)
  assert.ok(!evaluate(good).some(i => i.name === '检查命令的代理'))
})

test('gather：设置了检查命令的用户时真的切换一次；系统里没有这个用户时记成失败', () => {
  const f = gather({
    root: ROOT,
    dataDir: join(tmp(), 'data'),
    executors: noExecutors,
    masterKey: { kind: 'missing' },
    checkUser: { kind: 'invalid', error: 'EOS_CHECK_USER=nobody-here，但系统里没有这个用户' },
    agentUser: { kind: 'none' },
  })
  assert.deepEqual(f.checkUser, { kind: 'fail', error: 'EOS_CHECK_USER=nobody-here，但系统里没有这个用户' })
  // 测试进程没有切换用户的能力（CI 和本机都不是带 SETUID 的平台进程）：探测要报失败，而不是当成能切换。
  if (process.getuid?.() !== 0) {
    const g = gather({
      root: ROOT,
      dataDir: join(tmp(), 'data'),
      executors: noExecutors,
      masterKey: { kind: 'missing' },
      checkUser: { kind: 'ok', user: { name: 'nobody', gid: 65534, home: '/nonexistent' } },
      agentUser: { kind: 'none' },
    })
    assert.equal(g.checkUser.kind, 'fail')
  }
})

test('模型 key 显示来源：凭据存储、环境变量；读不出来时是 ✗，不悄悄改用环境变量', () => {
  assert.match(formatItems(evaluate(good)), /✓ DeepSeek API key：来自凭据存储（凭据 deepseek）/)
  assert.match(formatItems(evaluate(withDsh({ modelKey: { source: 'env' } }, platform))), /✓ DeepSeek API key：来自环境变量 DEEPSEEK_API_KEY（凭据存储里没有 deepseek）/)
  assert.match(
    formatItems(evaluate(withDsh({ modelKey: { source: 'error', error: '凭据 deepseek 解密失败' } }, platform))),
    /✗ DeepSeek API key：凭据存储里的 deepseek 读不出来：凭据 deepseek 解密失败\n  怎么修：/,
  )
})

test('dsh 的自检：读 dsh 版本；只记 key 的来源，不带值；入口配置错了时是 ✗', () => {
  const d = dshFacts(ctx({ source: 'credentials', value: 'sk-secret-value' }))
  assert.deepEqual(d.modelKey, { source: 'credentials' })
  assert.ok(!JSON.stringify(d).includes('sk-secret-value'))
  assert.match('version' in d.install ? d.install.version : '', /^0\.2\.2/)
  assert.deepEqual(dshFacts(ctx({ source: 'missing' })).modelKey, { source: 'missing' })
  const launcher = dshFacts(ctx({ source: 'missing' }, { EOS_DSH_LAUNCHER: join(tmp(), 'no-such-launcher') }))
  assert.match('error' in launcher.install ? launcher.install.error : '', /EOS_DSH_LAUNCHER=.*这个文件不存在/)
  assert.equal(dshHealth(launcher).items.find(i => i.name === 'dsh')?.status, 'fail', '启动前拦下，而不是等到第一次调用才失败')
})

test('gather：读 package.json 的 engines；执行器的自检原样带上；数据目录建不出来时记下原因', () => {
  const executors = [{ name: 'dsh', health: dshHealth(goodDsh) }]
  const f = gather({
    root: ROOT,
    dataDir: join(tmp(), 'data'),
    executors,
    masterKey: { kind: 'missing' },
    checkUser: { kind: 'none' },
    agentUser: { kind: 'none' },
  })
  assert.equal(f.nodeRequired, '>=24.9.0')
  assert.equal(f.node, process.versions.node)
  assert.deepEqual(f.executors, executors)
  assert.match('version' in f.git ? f.git.version : '', /^\d+\.\d+/)
  assert.equal(f.dataDirError, undefined)
  assert.ok(existsSync(f.dataDir), '和别的命令一样会建出数据目录')
  const file = join(tmp(), 'a-file')
  writeFileSync(file, '')
  const blocked = gather({ root: ROOT, dataDir: join(file, 'data'), executors: noExecutors, masterKey: { kind: 'missing' }, checkUser: { kind: 'none' }, agentUser: { kind: 'none' } })
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

test('模型接口地址：没设置时不显示；官方接口通过并显示路径；本机地址只在 doctor 里提示；别的主机提示 key 会发过去；格式不对时拦下', () => {
  const item = (f: Partial<DshFacts>) => evaluate(withDsh(f, platform)).find(i => i.name === '模型接口地址')
  assert.equal(item({}), undefined)
  const official = item({ modelBaseUrl: { kind: 'ok', host: 'api.deepseek.com', path: '/anthropic', loopback: false } })!
  assert.equal(official.status, 'ok')
  assert.match(official.detail, /api\.deepseek\.com\/anthropic/)
  const local = item({ modelBaseUrl: { kind: 'ok', host: '127.0.0.1:40137', path: '/anthropic', loopback: true } })!
  assert.deepEqual([local.status, local.doctorOnly], ['warn', true])
  const other = item({ modelBaseUrl: { kind: 'ok', host: 'gateway.example:8443', path: '/a', loopback: false } })!
  assert.deepEqual([other.status, other.doctorOnly], ['warn', undefined])
  assert.match(other.detail, /gateway\.example:8443.*模型 key/)
  assert.equal(item({ modelBaseUrl: { kind: 'invalid', error: 'EOS_MODEL_BASE_URL 里不能带用户名和密码' } })?.status, 'fail')
})

test('dsh 的自检按 EOS_MODEL_BASE_URL 收集解析后的主机，官方主机的判断不被大小写、端口、相似的主机名骗过；错误里不带原始地址', () => {
  const run = (value: string | undefined) => dshFacts(ctx({ source: 'missing' }, value === undefined ? {} : { EOS_MODEL_BASE_URL: value })).modelBaseUrl
  const status = (value: string) => {
    const u = run(value)
    return evaluate(withDsh(u === undefined ? {} : { modelBaseUrl: u }, platform)).find(i => i.name === '模型接口地址')!.status
  }
  assert.equal(run(undefined), undefined)
  assert.deepEqual(run('https://gateway.example:8443/anthropic'), { kind: 'ok', host: 'gateway.example:8443', path: '/anthropic', loopback: false })
  assert.deepEqual(run('http://127.0.0.1:12345/anthropic'), { kind: 'ok', host: '127.0.0.1:12345', path: '/anthropic', loopback: true })
  // 大小写和默认端口不影响判断（主机名拼出来写，免得被密钥扫描当成 key）
  const mixedCase = ['API', 'DeepSeek', 'com'].join('.')
  assert.equal(status(`https://${mixedCase}:443/anthropic`), 'ok')
  for (const lookalike of ['https://api.deepseek.com:8443/x', 'https://api.deepseek.com.evil.example/x', 'https://evilapi.deepseek.com/x']) {
    assert.equal(status(lookalike), 'warn', lookalike)
  }
  const relay = run('http://relay.internal/anthropic')
  assert.equal(relay?.kind, 'invalid')
  assert.equal(status('http://relay.internal/anthropic'), 'fail')
  const bad = run('https://user:secret-pw@gateway.example/anthropic')
  assert.equal(bad?.kind, 'invalid')
  assert.ok(!JSON.stringify(bad).includes('secret-pw'))
})
