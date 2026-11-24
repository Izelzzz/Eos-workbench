// 平台认得的托管平台，和按地址找出是哪一家。
import { githubForge } from './github.ts'
import type { Forge, RemoteRepo } from './types.ts'

/** 默认只接 github.com。 */
export const defaultForges = (): Forge[] => [githubForge()]

/** 地址看起来是远程仓库（而不是本机路径）：带协议，或者是 git@ 的写法。 */
export const looksRemote = (input: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) || /^[\w.-]+@[\w.-]+:/.test(input.trim())

export const parseRemote = (forges: Forge[], input: string): { repo: RemoteRepo; forge: Forge } | undefined => {
  for (const forge of forges) {
    const repo = forge.parse(input)
    if (repo !== undefined) return { repo, forge }
  }
  return undefined
}
