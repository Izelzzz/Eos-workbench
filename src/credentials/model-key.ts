// 模型 API key 从哪来：先看凭据存储里名为 deepseek 的凭据，没有再用平台启动时环境变量 DEEPSEEK_API_KEY 的值。
// 环境变量在启动时读出并从 process.env 删掉：之后平台起的子进程（git、检查命令）都继承不到它，只有 dsh 进程拿到 key。
import type { Credentials } from './store.ts'
import { LOCAL_OWNER } from './types.ts'

export const MODEL_KEY_ENV = 'DEEPSEEK_API_KEY'
export const MODEL_KEY_CREDENTIAL = 'deepseek'

export type ModelKey =
  | { source: 'credentials'; value: string }
  | { source: 'env'; value: string }
  | { source: 'missing' }
  /** 凭据存储里有这条，但读不出来（没有主密钥、换了主密钥、记录损坏）：不悄悄退回环境变量，免得用错 key。 */
  | { source: 'error'; error: string }

/** 读出环境变量里的 key 并从 env 删掉（空白算没有设置）。平台进程启动时调用一次。 */
export const takeModelKeyEnv = (env: NodeJS.ProcessEnv): string | undefined => {
  const value = (env[MODEL_KEY_ENV] ?? '').trim()
  delete env[MODEL_KEY_ENV]
  return value === '' ? undefined : value
}

export const resolveModelKey = (credentials: Credentials | undefined, envValue: string | undefined): ModelKey => {
  const stored = credentials?.get(LOCAL_OWNER, MODEL_KEY_CREDENTIAL) ?? { kind: 'absent' as const }
  if (stored.kind === 'ok') return { source: 'credentials', value: stored.value }
  if (stored.kind === 'error') return { source: 'error', error: stored.error }
  return envValue === undefined ? { source: 'missing' } : { source: 'env', value: envValue }
}
