// 执行器要的模型 API key 从哪来：先看凭据存储里执行器声明的那条凭据，没有再用平台启动时那个环境变量的值
// （凭据名和变量名由各执行器声明，见 src/executor/types.ts 的 ModelKeySpec）。
// 环境变量在启动时读出并从 process.env 删掉：之后平台起的子进程（git、检查命令）都继承不到它，只有执行器拿到 key。
import type { Credentials } from './store.ts'
import { LOCAL_OWNER } from './types.ts'

export type ModelKey =
  | { source: 'credentials'; value: string }
  | { source: 'env'; value: string }
  | { source: 'missing' }
  /** 凭据存储里有这条，但读不出来（没有主密钥、换了主密钥、记录损坏）：不悄悄退回环境变量，免得用错 key。 */
  | { source: 'error'; error: string }

/** 读出环境变量 name 里的 key 并从 env 删掉（空白算没有设置）。平台进程启动时对每个执行器声明的变量调用一次。 */
export const takeKeyEnv = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = (env[name] ?? '').trim()
  delete env[name]
  return value === '' ? undefined : value
}

/** credential：凭据存储里的名字；envValue：启动时取走的环境变量的值。 */
export const resolveModelKey = (credentials: Credentials | undefined, credential: string, envValue: string | undefined): ModelKey => {
  const stored = credentials?.get(LOCAL_OWNER, credential) ?? { kind: 'absent' as const }
  if (stored.kind === 'ok') return { source: 'credentials', value: stored.value }
  if (stored.kind === 'error') return { source: 'error', error: stored.error }
  return envValue === undefined ? { source: 'missing' } : { source: 'env', value: envValue }
}
