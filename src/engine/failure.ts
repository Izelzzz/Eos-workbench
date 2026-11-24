// 失败原因：写清哪一步、什么原因、怎么修。纯函数，引擎和 runner 共用。日志路径不存进失败原因，由命令行和网页按任务显示。
// 「怎么修」按错误文字匹配下面的表，先匹配到的为准；认不出的错误让人看日志。

type Rule = { test: RegExp; fix: string }

/** 错误文字 → 怎么修。匹配的是 dsh、git、Node 抛出来的原始错误文字；dsh 的两条（runtime exited、working-directory）取自 E2E 里的真实报错。 */
export const RULES: Rule[] = [
  { test: /\b401\b|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication/i, fix: 'API key 无效或过期：检查启动平台的环境变量 DEEPSEEK_API_KEY，换成有效的 key 后重启平台' },
  { test: /\b402\b|insufficient[ _]balance|余额/i, fix: '账户余额不足：给 DeepSeek 账户充值后重试' },
  { test: /\b429\b|rate[ _]?limit|too many requests/i, fix: '请求太频繁被限流：等一会儿再重试' },
  { test: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network|(connection|socket|other side) closed/i, fix: '连不上模型服务：检查平台所在机器的网络和代理设置（能否访问 api.deepseek.com）' },
  { test: /^提交改动失败|working-directory: directory does not exist|not a git repository|worktree 不存在/i, fix: '任务的 worktree 被删除或损坏：确认 worktree 目录还在、主仓库里还有它的登记（git worktree list）' },
  { test: /^检查无法执行/, fix: '检查命令起不来：确认工作流里检查的命令在平台所在机器上装好了、能在 worktree 里运行' },
  { test: /runtime exited|process (exited|terminated)|exited with code|SIGKILL|SIGTERM|进程(退出|崩溃)|进程.*被关闭/i, fix: 'agent 进程意外退出：直接重试；反复出现时看日志里 dsh 的报错' },
]

export const fixFor = (error: string): string => RULES.find(r => r.test.test(error))?.fix ?? '没有认出这个错误：看日志里这一步前后的详细输出'

/** 失败原因的全文。where 例如「[build] developer · produce（调用 c3）」；fix 不给时按错误文字查表。 */
export const explain = (o: { where: string; error: string; task: string; fix?: string }): string =>
  `哪一步：${o.where}\n原因：${o.error}\n怎么修：${o.fix ?? fixFor(o.error)}。处理后在任务页点「重试」，或运行 npm run eos -- retry ${o.task}`

/** 失败原因里给调用日志和改进证据用的部分：只留「哪一步」「原因」两段（是事实），不带平台写的修法。不是 explain 的格式时原样返回。 */
export const failureFacts = (failure: string): string => {
  const lines = failure.split('\n')
  return lines[0]?.startsWith('哪一步：') && lines[1]?.startsWith('原因：') ? `${lines[0]}；${lines[1]}` : failure
}
