import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import { MASTER_KEY_ENV, parseMasterKey, takeMasterKey, type MasterKey } from '../src/credentials/key.ts'
import { Credentials } from '../src/credentials/store.ts'
import { LOCAL_OWNER, type Owner } from '../src/credentials/types.ts'

const ROOT = join(import.meta.dirname, '..')
const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = mkdtempSync(join(ROOT, 'node_modules', '.eos-cred-'))
  dirs.push(d)
  return d
}

const keyOf = (fill: number): MasterKey => {
  const s = parseMasterKey(Buffer.alloc(32, fill).toString('base64'))
  assert.equal(s.kind, 'ok')
  return (s as { key: MasterKey }).key
}
const K1 = keyOf(1)
const K2 = keyOf(2)
const SECRET = 'sk-test-0123456789-very-secret-value'

test('主密钥：32 字节 base64 才算有效；空白算没设置；指纹是 16 位十六进制且不含密钥本身', () => {
  assert.deepEqual(parseMasterKey(undefined), { kind: 'missing' })
  assert.deepEqual(parseMasterKey('  '), { kind: 'missing' })
  assert.equal(parseMasterKey('not*base64').kind, 'invalid')
  assert.match((parseMasterKey(Buffer.alloc(16).toString('base64')) as { error: string }).error, /16 字节，需要 32 字节/)
  const full = Buffer.alloc(32, 3).toString('base64')
  assert.equal(full.endsWith('='), true)
  assert.deepEqual(parseMasterKey(full.replace(/=+$/, '')), parseMasterKey(full), '省略末尾的 = 也认')
  assert.match(K1.id, /^[0-9a-f]{16}$/)
  assert.notEqual(K1.id, K2.id)
})

test('takeMasterKey 读出后从环境里删掉（格式不对也删）', () => {
  const env: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: Buffer.alloc(32, 1).toString('base64'), PATH: '/bin' }
  assert.equal(takeMasterKey(env).kind, 'ok')
  assert.deepEqual(env, { PATH: '/bin' })
  const bad: NodeJS.ProcessEnv = { [MASTER_KEY_ENV]: 'xx' }
  assert.equal(takeMasterKey(bad).kind, 'invalid')
  assert.equal(MASTER_KEY_ENV in bad, false)
})

test('保存、读取、替换、删除；列表不带值；替换保留创建时间', () => {
  let t = 1000
  const c = new Credentials(':memory:', K1, () => t)
  assert.deepEqual(c.put(LOCAL_OWNER, 'deepseek', 'api-key', SECRET), { ok: true })
  assert.deepEqual(c.get(LOCAL_OWNER, 'deepseek'), { kind: 'ok', value: SECRET })
  t = 2000
  assert.deepEqual(c.put(LOCAL_OWNER, 'deepseek', 'api-key', 'second'), { ok: true })
  assert.deepEqual(c.get(LOCAL_OWNER, 'deepseek'), { kind: 'ok', value: 'second' })
  assert.deepEqual(c.list(LOCAL_OWNER), [{ name: 'deepseek', kind: 'api-key', keyId: K1.id, createdAt: 1000, updatedAt: 2000 }])
  assert.ok(!JSON.stringify(c.list(LOCAL_OWNER)).includes('second'))
  assert.equal(c.delete(LOCAL_OWNER, 'deepseek'), true)
  assert.equal(c.delete(LOCAL_OWNER, 'deepseek'), false)
  assert.deepEqual(c.get(LOCAL_OWNER, 'deepseek'), { kind: 'absent' })
})

test('凭据按 owner 分开：别人的同名凭据看不到、删不掉', () => {
  const c = new Credentials(':memory:', K1)
  const other = 'user-2' as Owner
  c.put(LOCAL_OWNER, 'github.com', 'token', SECRET)
  assert.deepEqual(c.list(other), [])
  assert.deepEqual(c.get(other, 'github.com'), { kind: 'absent' })
  assert.equal(c.delete(other, 'github.com'), false)
  assert.equal(c.get(LOCAL_OWNER, 'github.com').kind, 'ok')
})

test('输入检查：名字、类型、空值、超长都拒绝，报中文原因', () => {
  const c = new Credentials(':memory:', K1)
  for (const name of ['', 'Upper', '-x', 'a/b', 'a b', 'x'.repeat(65)]) assert.equal((c.put(LOCAL_OWNER, name, 'token', 'v') as { error: string }).error.startsWith('凭据名不合规：'), true, name)
  assert.match((c.put(LOCAL_OWNER, 'x', 'password' as never, 'v') as { error: string }).error, /不认识的凭据类型/)
  assert.match((c.put(LOCAL_OWNER, 'x', 'token', '  ') as { error: string }).error, /不能为空/)
  assert.match((c.put(LOCAL_OWNER, 'x', 'token', 'v'.repeat(16 * 1024 + 1)) as { error: string }).error, /超过 16KB/)
  assert.deepEqual(c.list(LOCAL_OWNER), [])
})

test('没有主密钥：保存和读取都报中文错误并写明怎么生成；列表和删除照常', () => {
  const path = join(tmp(), 'eos.db')
  new Credentials(path, K1).put(LOCAL_OWNER, 'deepseek', 'api-key', SECRET)
  const c = new Credentials(path, undefined)
  assert.equal(c.usable, false)
  assert.match(
    (c.put(LOCAL_OWNER, 'x', 'token', 'v') as { error: string }).error,
    /^没有设置主密钥 EOS_MASTER_KEY，不能保存或读取凭据。平台用主密钥加密保存凭据。设置方法：① 生成：openssl rand -base64 32/,
  )
  assert.match((c.get(LOCAL_OWNER, 'deepseek') as { error: string }).error, /没有设置主密钥/)
  assert.equal(c.list(LOCAL_OWNER).length, 1)
  assert.equal(c.delete(LOCAL_OWNER, 'deepseek'), true)
})

test('换了主密钥读不出来，报出两边的指纹', () => {
  const path = join(tmp(), 'eos.db')
  new Credentials(path, K1).put(LOCAL_OWNER, 'deepseek', 'api-key', SECRET)
  const r = new Credentials(path, K2).get(LOCAL_OWNER, 'deepseek')
  assert.equal(r.kind, 'error')
  assert.match((r as { error: string }).error, new RegExp(`另一个主密钥（指纹 ${K1.id}）.*当前主密钥的指纹是 ${K2.id}`))
})

test('篡改：密文、标签被改，或把一行的密文挪到另一行（名字、类型、owner 不同），都解密失败', () => {
  const path = join(tmp(), 'eos.db')
  const c = new Credentials(path, K1)
  c.put(LOCAL_OWNER, 'a', 'token', SECRET)
  c.put(LOCAL_OWNER, 'b', 'token', 'other')
  c.put('user-2' as Owner, 'a', 'token', 'theirs')
  const db = new DatabaseSync(path)
  const copy = (from: string, fromOwner: string, to: string, toOwner: string) =>
    db
      .prepare(
        'UPDATE credentials SET iv = (SELECT iv FROM credentials WHERE owner = ? AND name = ?), tag = (SELECT tag FROM credentials WHERE owner = ? AND name = ?), ciphertext = (SELECT ciphertext FROM credentials WHERE owner = ? AND name = ?) WHERE owner = ? AND name = ?',
      )
      .run(fromOwner, from, fromOwner, from, fromOwner, from, toOwner, to)
  copy('a', 'local', 'b', 'local')
  assert.match((c.get(LOCAL_OWNER, 'b') as { error: string }).error, /解密失败/, '换名字')
  copy('a', 'local', 'a', 'user-2')
  assert.match((c.get('user-2' as Owner, 'a') as { error: string }).error, /解密失败/, '换 owner')
  db.prepare("UPDATE credentials SET kind = 'api-key' WHERE owner = 'local' AND name = 'a'").run()
  assert.match((c.get(LOCAL_OWNER, 'a') as { error: string }).error, /解密失败/, '改类型')
  db.prepare("UPDATE credentials SET kind = 'token' WHERE owner = 'local' AND name = 'a'").run()
  assert.equal(c.get(LOCAL_OWNER, 'a').kind, 'ok')
  db.prepare("UPDATE credentials SET tag = substr(tag, 1, 4) WHERE owner = 'local' AND name = 'a'").run()
  assert.match((c.get(LOCAL_OWNER, 'a') as { error: string }).error, /解密失败/, '截短的认证标签')
  c.put(LOCAL_OWNER, 'a', 'token', SECRET)
  db.prepare("UPDATE credentials SET ciphertext = zeroblob(length(ciphertext)) WHERE owner = 'local' AND name = 'a'").run()
  assert.match((c.get(LOCAL_OWNER, 'a') as { error: string }).error, /解密失败/, '改密文')
  c.put(LOCAL_OWNER, 'a', 'token', SECRET)
  db.prepare("UPDATE credentials SET iv = zeroblob(12) WHERE owner = 'local' AND name = 'a'").run()
  assert.match((c.get(LOCAL_OWNER, 'a') as { error: string }).error, /解密失败/, '改 IV')
  db.close()
})

test('数据库行格式不对：列表照样列出（不认识的类型标成 unknown），读取报"记录格式不对"', () => {
  const path = join(tmp(), 'eos.db')
  const c = new Credentials(path, K1, () => 5)
  c.put(LOCAL_OWNER, 'a', 'token', SECRET)
  c.put(LOCAL_OWNER, 'b', 'token', SECRET)
  const db = new DatabaseSync(path)
  db.prepare("UPDATE credentials SET kind = 'ssh-key' WHERE name = 'a'").run()
  db.prepare("UPDATE credentials SET iv = 'text' WHERE name = 'b'").run()
  c.put(LOCAL_OWNER, 'c', 'token', SECRET)
  db.prepare("UPDATE credentials SET created_at = 'not-a-number' WHERE name = 'c'").run()
  db.close()
  assert.deepEqual(
    c.list(LOCAL_OWNER).map(i => [i.name, i.kind]),
    [
      ['a', 'unknown'],
      ['b', 'token'],
      ['c', 'unknown'],
    ],
  )
  assert.equal(c.delete(LOCAL_OWNER, 'c'), true, '列出来的坏行能删掉')
  assert.match((c.get(LOCAL_OWNER, 'a') as { error: string }).error, /类型「ssh-key」不认识/)
  assert.match((c.get(LOCAL_OWNER, 'b') as { error: string }).error, /记录格式不对/)
})

test('数据库文件（含 WAL）里找不到明文；同一个值存两次密文不同', () => {
  const dir = tmp()
  const c = new Credentials(join(dir, 'eos.db'), K1)
  c.put(LOCAL_OWNER, 'a', 'token', SECRET)
  c.put(LOCAL_OWNER, 'b', 'token', SECRET)
  for (const f of readdirSync(dir)) assert.ok(!readFileSync(join(dir, f)).includes(SECRET), f)
  const db = new DatabaseSync(join(dir, 'eos.db'))
  const rows = db.prepare('SELECT ciphertext FROM credentials').all() as { ciphertext: Uint8Array }[]
  assert.notDeepEqual(Buffer.from(rows[0]!.ciphertext), Buffer.from(rows[1]!.ciphertext))
  db.close()
  c.close()
})

test('平台进程读出主密钥后，起的子进程环境里没有它', () => {
  const key = Buffer.alloc(32, 9).toString('base64')
  const script = `import { takeMasterKey } from ${JSON.stringify(join(ROOT, 'src/credentials/key.ts'))}
import { execFileSync } from 'node:child_process'
takeMasterKey(process.env)
process.stdout.write(execFileSync('env', { encoding: 'utf8' }))`
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, [MASTER_KEY_ENV]: key } })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!r.stdout.includes(MASTER_KEY_ENV) && !r.stdout.includes(key), r.stdout)
})
