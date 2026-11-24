// 凭据存储：每条凭据用主密钥做 AES-256-GCM 加密后存进 SQLite（和任务同一个数据库文件，单独的连接）。
// - 认证数据（AAD）绑定版本、owner、名字、类型：把一行的密文挪到另一行（例如换成别人的、换成另一种凭据）会解密失败。
// - 每条存加密它的主密钥指纹（key_id）：主密钥换了以后能报出"这条要重新录入"，而不是笼统的解密失败。
// - 列表只给名字、类型和时间，不解密；值只有 get 能拿到，只在平台进程里用。
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { GENERATE_HINT, MASTER_KEY_ENV, type MasterKey } from './key.ts'
import { CREDENTIAL_KINDS, type CredentialInfo, type CredentialKind, type Owner } from './types.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  key_id TEXT NOT NULL,
  iv BLOB NOT NULL,
  tag BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, name)
);`

/** 凭据名：小写字母、数字开头，可以有 . _ - :，例如 deepseek、github.com、git.example.com:8443。 */
export const NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/

/** 值的上限：GitHub App 的私钥（PEM）也放得下。 */
export const MAX_VALUE_BYTES = 16 * 1024

const aad = (owner: Owner, name: string, kind: CredentialKind): Buffer => Buffer.from(['eos-credential:v1', owner, name, kind].join('\0'), 'utf8')

const NO_KEY = `没有设置主密钥 ${MASTER_KEY_ENV}，不能保存或读取凭据。${GENERATE_HINT}`

export type PutResult = { ok: true } | { ok: false; error: string }
export type GetResult = { kind: 'ok'; value: string } | { kind: 'absent' } | { kind: 'error'; error: string }

/** 数据库行在这里解析：别的工具写进来的、类型不对的行报"记录格式不对"，而不是当成被篡改。 */
const infoRow = z.object({ name: z.string(), kind: z.string(), key_id: z.string(), created_at: z.number(), updated_at: z.number() })
const sealedRow = infoRow.extend({ iv: z.instanceof(Uint8Array), tag: z.instanceof(Uint8Array), ciphertext: z.instanceof(Uint8Array) })

const isKind = (k: string): k is CredentialKind => (CREDENTIAL_KINDS as readonly string[]).includes(k)

export class Credentials {
  private readonly db: DatabaseSync

  constructor(path: string, private readonly key: MasterKey | undefined, private readonly now: () => number = Date.now) {
    this.db = new DatabaseSync(path, { timeout: 10_000 })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  /** 有没有可用的主密钥：没有时只能列出和删除。 */
  get usable(): boolean {
    return this.key !== undefined
  }

  /** 当前主密钥的指纹；没有主密钥时是 undefined。 */
  get keyId(): string | undefined {
    return this.key?.id
  }

  list(owner: Owner): CredentialInfo[] {
    return this.db.prepare('SELECT name, kind, key_id, created_at, updated_at FROM credentials WHERE owner = ? ORDER BY name').all(owner).flatMap(raw => {
      const r = infoRow.safeParse(raw).data
      // 格式不对的行也列出来（类型标成 unknown），让人能找到并删掉。
      if (r === undefined) return [{ name: String((raw as { name?: unknown }).name), kind: 'unknown' as const, keyId: '', createdAt: 0, updatedAt: 0 }]
      return [{ name: r.name, kind: isKind(r.kind) ? r.kind : 'unknown' as const, keyId: r.key_id, createdAt: r.created_at, updatedAt: r.updated_at }]
    })
  }

  /** 新建或替换一条凭据。替换时保留创建时间。 */
  put(owner: Owner, name: string, kind: CredentialKind, value: string): PutResult {
    if (this.key === undefined) return { ok: false, error: NO_KEY }
    // 不回显名字：用户可能把值误填进了名字。
    if (!NAME.test(name)) return { ok: false, error: '凭据名不合规：只能用小写字母、数字和 . _ - :，以字母或数字开头，最长 64 个字符' }
    if (!isKind(kind)) return { ok: false, error: `不认识的凭据类型「${String(kind)}」，可选：${CREDENTIAL_KINDS.join('、')}` }
    if (value.trim() === '') return { ok: false, error: '凭据的值不能为空' }
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) return { ok: false, error: `凭据的值超过 ${MAX_VALUE_BYTES / 1024}KB` }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key.key, iv, { authTagLength: 16 })
    cipher.setAAD(aad(owner, name, kind))
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const at = this.now()
    this.db.prepare(`INSERT INTO credentials (owner, name, kind, key_id, iv, tag, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (owner, name) DO UPDATE SET kind = excluded.kind, key_id = excluded.key_id, iv = excluded.iv, tag = excluded.tag, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`)
      .run(owner, name, kind, this.key.id, iv, cipher.getAuthTag(), ciphertext, at, at)
    return { ok: true }
  }

  get(owner: Owner, name: string): GetResult {
    const raw = this.db.prepare('SELECT name, kind, key_id, iv, tag, ciphertext, created_at, updated_at FROM credentials WHERE owner = ? AND name = ?').get(owner, name)
    if (raw === undefined) return { kind: 'absent' }
    if (this.key === undefined) return { kind: 'error', error: NO_KEY }
    const r = sealedRow.safeParse(raw).data
    if (r === undefined) return { kind: 'error', error: `凭据 ${name} 在数据库里的记录格式不对，请删掉重新录入` }
    if (!isKind(r.kind)) return { kind: 'error', error: `凭据 ${name} 的类型「${r.kind}」不认识，请删掉重新录入` }
    if (r.key_id !== this.key.id) return { kind: 'error', error: `凭据 ${name} 是用另一个主密钥（指纹 ${r.key_id}）加密的，当前主密钥的指纹是 ${this.key.id}。换回原来的 ${MASTER_KEY_ENV}，或重新录入这条凭据` }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key.key, r.iv, { authTagLength: 16 })
      decipher.setAAD(aad(owner, r.name, r.kind))
      decipher.setAuthTag(r.tag)
      return { kind: 'ok', value: Buffer.concat([decipher.update(r.ciphertext), decipher.final()]).toString('utf8') }
    } catch {
      return { kind: 'error', error: `凭据 ${name} 解密失败：数据库里的这条记录被改动过或已损坏，请删掉重新录入` }
    }
  }

  /** 删掉一条凭据；不存在时返回 false。没有主密钥也能删。 */
  delete(owner: Owner, name: string): boolean {
    return this.db.prepare('DELETE FROM credentials WHERE owner = ? AND name = ?').run(owner, name).changes > 0
  }
}
