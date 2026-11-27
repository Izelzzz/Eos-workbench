// 凭据的主密钥：从平台进程的环境变量 EOS_MASTER_KEY 读，32 字节、base64 编码。
// 读出来之后立刻从 process.env 里删掉：平台之后起的子进程（dsh、git、检查命令）都继承不到它。
// 主密钥不落盘：agent 的沙箱能只读整个文件系统，放在磁盘上就等于 agent 能读到。
import { createHash } from 'node:crypto'

export const MASTER_KEY_ENV = 'EOS_MASTER_KEY'

/** id：主密钥的指纹（sha256 的前 16 位十六进制），存在每条凭据上，用来认出"用别的主密钥加密的凭据"。 */
export type MasterKey = { readonly id: string; readonly key: Buffer }

export type MasterKeyState = { kind: 'ok'; key: MasterKey } | { kind: 'missing' } | { kind: 'invalid'; error: string }

/** 怎么设置主密钥：eos doctor、Web 的凭据页和代码托管页、凭据存储的报错都用这一份。 */
export const GENERATE_HINT = `平台用主密钥加密保存凭据。设置方法：① 生成：openssl rand -base64 32（没有 openssl 时：node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"），把值备份到这台服务器以外的地方（例如密码管理器）：丢了它，存过的凭据只能重新录入；② 启动平台时交给它：read -rs ${MASTER_KEY_ENV}; ${MASTER_KEY_ENV}=$${MASTER_KEY_ENV} npm run eos -- web（read 读入时不显示、不进 shell 历史，值只交给这一个命令）。不要把值写进这台服务器上的文件或 ~/.zshrc 这类启动配置（agent 能读到平台用户能读的文件，启动配置会被所有程序继承），也不要直接敲在命令行里（会进 shell 历史）；③ Docker 部署：写进宿主机上的 .env，见 docs/deploy.md`

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export const parseMasterKey = (raw: string | undefined): MasterKeyState => {
  const text = (raw ?? '').trim()
  if (text === '') return { kind: 'missing' }
  // 接受省略了末尾 = 的写法。
  const padded = text.padEnd(Math.ceil(text.length / 4) * 4, '=')
  if (!BASE64.test(padded) || text.length % 4 === 1) return { kind: 'invalid', error: `${MASTER_KEY_ENV} 不是 base64 编码` }
  const key = Buffer.from(padded, 'base64')
  if (key.length !== 32) return { kind: 'invalid', error: `${MASTER_KEY_ENV} 解码后是 ${key.length} 字节，需要 32 字节` }
  return { kind: 'ok', key: { id: createHash('sha256').update(key).digest('hex').slice(0, 16), key } }
}

/** 读出主密钥并从 env 里删掉（不论格式对不对）。平台进程启动时调用一次。 */
export const takeMasterKey = (env: NodeJS.ProcessEnv): MasterKeyState => {
  const state = parseMasterKey(env[MASTER_KEY_ENV])
  delete env[MASTER_KEY_ENV]
  return state
}
