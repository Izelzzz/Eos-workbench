import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { asUser, killUserProcessesIn, parseCheckUser, readSessionLogAs, resolveCheckUser } from '../src/runner/check-user.ts'
import { checkEnv, droppedProxies, runChecks } from '../src/runner/checks.ts'

const PASSWD = 'root:x:0:0:root:/root:/bin/bash\neos:x:10001:10001::/home/eos:/bin/bash\neos-check:x:10002:10002::/home/eos-check:/bin/sh\n'
const dir = () => mkdtempSync(join(import.meta.dirname, '..', 'node_modules', '.eos-check-user-'))

test('the check user comes from EOS_CHECK_USER and /etc/passwd; a missing or malformed user is an error, never a silent fallback', () => {
  assert.deepEqual(parseCheckUser('eos-check', PASSWD), { name: 'eos-check', gid: 10002, home: '/home/eos-check' })
  assert.equal(parseCheckUser('eos-chec', PASSWD), undefined)
  assert.deepEqual(
    resolveCheckUser({}, () => PASSWD),
    { kind: 'none' },
  )
  assert.deepEqual(
    resolveCheckUser({ EOS_CHECK_USER: '' }, () => PASSWD),
    { kind: 'none' },
  )
  assert.deepEqual(
    resolveCheckUser({ EOS_CHECK_USER: 'eos-check' }, () => PASSWD),
    { kind: 'ok', user: { name: 'eos-check', gid: 10002, home: '/home/eos-check' } },
  )
  assert.deepEqual(
    resolveCheckUser({ EOS_CHECK_USER: 'nobody-here' }, () => PASSWD),
    { kind: 'invalid', error: 'EOS_CHECK_USER=nobody-here，但系统里没有这个用户' },
  )
  assert.equal(resolveCheckUser({ EOS_CHECK_USER: '--reuid=0' }, () => PASSWD).kind, 'invalid')
})

test('switching users also clears every capability, so a check cannot switch back', () => {
  assert.deepEqual(asUser({ name: 'eos-check', gid: 10002, home: '/home/eos-check' }, ['npm', 'test']), [
    'setpriv',
    '--reuid=eos-check',
    '--regid=10002',
    '--init-groups',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--',
    'npm',
    'test',
  ])
})

test("checks get certificates and proxies without credentials; HOME is the check user's own", () => {
  const env = {
    PATH: '/bin',
    HOME: '/home/eos',
    NODE_EXTRA_CA_CERTS: '/ca.pem',
    SSL_CERT_FILE: '/ca.pem',
    HTTPS_PROXY: 'http://proxy:3128',
    http_proxy: 'http://u:p@proxy:3128',
    NO_PROXY: 'localhost',
    DEEPSEEK_API_KEY: 'sk',
  }
  const { GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0, ...rest } = checkEnv(env, { name: 'eos-check', gid: 10002, home: '/home/eos-check' })
  assert.deepEqual([GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0], ['1', 'safe.directory', '*'], 'git runs in a worktree owned by the platform user')
  assert.deepEqual(rest, { PATH: '/bin', HOME: '/home/eos-check', NODE_EXTRA_CA_CERTS: '/ca.pem', SSL_CERT_FILE: '/ca.pem', NO_PROXY: 'localhost', HTTPS_PROXY: 'http://proxy:3128', CI: '1' })
  assert.deepEqual(droppedProxies(env), ['http_proxy'])
  assert.equal(checkEnv(env).HOME, '/home/eos', 'without a check user HOME is unchanged')
})

/** 假的 setpriv：记下要切换到的用户和命令，再执行 -- 后面的命令。 */
const fakeSetpriv = () => {
  const bin = dir()
  const log = join(bin, 'calls.log')
  writeFileSync(join(bin, 'setpriv'), `#!/bin/sh\nuser="$1"\nwhile [ "$1" != "--" ]; do shift; done\nshift\necho "$user $*" >> ${log}\nexec "$@"\n`)
  chmodSync(join(bin, 'setpriv'), 0o755)
  return { env: { PATH: `${bin}:${process.env.PATH}`, HOME: '/home/eos' }, calls: () => readFileSync(log, 'utf8').trim().split('\n') }
}

test("with a check user, the command runs through setpriv with that user's HOME, and a hung command is killed as that user", async () => {
  const { env, calls } = fakeSetpriv()
  const user = { name: 'eos-check', gid: 10002, home: '/home/eos-check' }
  const [ok] = await runChecks(dir(), [{ kind: 'run', run: ['sh', '-c', 'test "$HOME" = /home/eos-check'], timeoutSec: 10 }], env, undefined, undefined, user)
  assert.equal(ok?.passed, true, ok?.detail)
  const started = Date.now()
  const [hung] = await runChecks(dir(), [{ kind: 'run', run: ['sh', '-c', 'sleep 30 & sleep 30'], timeoutSec: 1 }], env, undefined, undefined, user)
  assert.match(hung!.detail, /超过 1 秒没有结束，已终止/)
  assert.ok(Date.now() - started < 10_000)
  const log = calls()
  assert.ok(
    log.every(l => l.startsWith('--reuid=eos-check ')),
    log.join('\n'),
  )
  assert.ok(
    log.some(l => /^--reuid=eos-check kill -KILL -- -\d+$/.test(l)),
    log.join('\n'),
  )
})

test('leftover processes of the check user inside the worktree are killed as that user; processes elsewhere are left alone', async () => {
  const { env, calls } = fakeSetpriv()
  const w = dir()
  mkdirSync(join(w, 'sub'))
  const inside = spawn('sleep', ['30'], { cwd: join(w, 'sub'), stdio: 'ignore', detached: true })
  const outside = spawn('sleep', ['30'], { cwd: dir(), stdio: 'ignore', detached: true })
  await new Promise(r => setTimeout(r, 200))
  const path = process.env.PATH
  process.env.PATH = env.PATH
  try {
    assert.deepEqual(await killUserProcessesIn({ name: 'eos-check', gid: 10002, home: '/home/eos-check' }, w), [inside.pid])
    assert.deepEqual(await killUserProcessesIn({ name: 'eos-check', gid: 10002, home: '/home/eos-check' }, join(w, 'gone')), [], 'a worktree that is gone is not an error')
  } finally {
    process.env.PATH = path
    outside.kill('SIGKILL')
  }
  assert.ok(calls().some(l => l.startsWith('--reuid=eos-check sh -c ')))
})

test('reading a dsh session log as the agent user finds the same file the default reader does, and nothing for other ids', async () => {
  const { env, calls } = fakeSetpriv()
  const root = dir()
  mkdirSync(join(root, '--wt--', 'session-abc'), { recursive: true })
  writeFileSync(join(root, '--wt--', 'session-abc', 'session.v4.jsonl.zstd'), Buffer.from([1, 2, 3]))
  const path = process.env.PATH
  process.env.PATH = env.PATH
  try {
    const read = readSessionLogAs({ name: 'eos-agent', gid: 10003, home: '/home/eos-agent' }, 'session.v4.jsonl.zstd')
    assert.deepEqual(read(root, 'session-abc'), Buffer.from([1, 2, 3]))
    assert.equal(read(root, 'session-missing'), undefined)
    assert.equal(read(root, '../escape'), undefined, 'ids are checked before they reach the shell')
  } finally {
    process.env.PATH = path
  }
  assert.ok(calls().every(l => l.startsWith('--reuid=eos-agent sh -c ')))
})
