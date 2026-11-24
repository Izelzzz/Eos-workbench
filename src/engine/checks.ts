// 检查的文字说明：给 agent 的提示词、给用户的问题和日志共用。纯函数。
import type { Check, PlatformAction } from '../workflow/types.ts'
import type { CheckResult } from './types.ts'

const PLATFORM: Record<PlatformAction, string> = { push: '平台把任务分支推到远程仓库' }

export const describeCheck = (c: Check): string =>
  c.kind === 'file'
    ? `文件 ${c.path}${c.sections.length === 0 ? ' 存在' : ` 存在并包含章节：${c.sections.join('、')}`}`
    : c.kind === 'run'
      ? `命令 \`${c.run.join(' ')}\` 在 ${c.timeoutSec} 秒内成功退出`
      : PLATFORM[c.action]

export const allPassed = (results: CheckResult[]): boolean => results.every(r => r.passed)

/** 没通过的检查逐条列出，带上原因。 */
export const describeFailures = (results: CheckResult[]): string =>
  results.filter(r => !r.passed).map(r => `- ${describeCheck(r.check)}：没有通过${r.detail.trim() === '' ? '' : `\n\n${r.detail.trim()}`}`).join('\n\n')

export const describeRequirements = (checks: Check[]): string => checks.map(c => `- ${describeCheck(c)}`).join('\n')
