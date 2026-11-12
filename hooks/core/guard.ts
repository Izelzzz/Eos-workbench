// 任务进行中，合并、推送、发布、部署只能由流水线在人工批准后执行，模型不能直接跑。

const BUILTIN: readonly RegExp[] = [
  // git 后可带全局选项（-C <dir>、-c k=v、--no-pager 等）
  /\bgit(?:\s+-[Cc]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+(?:push|merge|rebase)(?![\w-])/,
  /\bgh\s+pr\s+merge\b/,
  /\bgh\s+release\s+create\b/,
  /\bnpm\s+publish\b/,
  /\b(?:pnpm|yarn)\s+publish\b/,
  /\bwrangler\s+(?:deploy|publish|pages\s+deploy)\b/,
  /\bvercel\b.*(?:--prod|deploy)/,
  /\bnetlify\s+deploy\b/,
  /\bfly(?:ctl)?\s+deploy\b/,
  /\bkubectl\s+(?:apply|rollout|set\s+image)\b/,
  /\bterraform\s+apply\b/,
  /\bhelm\s+(?:install|upgrade)\b/,
  /\bdocker\s+push\b/,
]

/** 编译用户在 .eos.json 里写的额外正则；写错的条目忽略。 */
export const compilePatterns = (extra: readonly string[] = []): RegExp[] => [
  ...BUILTIN,
  ...extra.flatMap(source => {
    try {
      return [new RegExp(source)]
    } catch {
      return []
    }
  }),
]

/** 命令是否受保护；返回命中的规则，未命中返回 undefined。 */
export const protectedMatch = (command: string, patterns: readonly RegExp[]): string | undefined =>
  patterns.find(p => p.test(command))?.source
