# 第 4 块 PR3：生成改进提案 E2E（真实模型）

脚本：`scripts/improve-e2e.ts`。命令：`node --import tsx scripts/improve-e2e.ts`。

## 做法

场景和 PR1、PR2 一样：团队规则「导出函数要有带 @example 的 JSDoc」只写进 reviewer 模板第 2 版，开发看不到。

1. 并行跑 3 个 standard 任务（sum、max、avg）。agent 提问时自动回答，任务失败时自动重试。全部结束后关掉 web。
2. 用命令行运行 `eos improve --workflow standard`，调用真实的 improver。
3. 用 `eos approve <id>` 批准，再用 `eos proposals` 查看结果。

## 结果（最终代码 `5c952f0`，即处理完两轮独立审查之后：`report.json`、`run.log`）

11 项核对全部通过：

- 3 个任务都完成，任务里有证据：3 条证据，都是 `review_changes`，被评判的角色都是 developer。
- `eos improve` 成功，生成了 2 条提案。生成过程中没有改任何约定，也没有调用任何工具（调用了的话，这次生成会作废）。
- 每条提案引用的证据都是程序归纳出的证据；目标都是有证据的约定，并且基于当前版本；内容能通过保存校验，没有改权限；都记下了生成它的模型调用。
- 至少一条提案把 @example 规则写进了 developer 模板或约定文档。
- `eos approve` 生成了新版本，备注写明提案号；`eos proposals` 显示这条提案已批准。

improver 调用一次：17.9 秒，输入 3482，输出 2937，缓存读 2688。两条提案相对当前版本的改动：

| 提案 | 目标 | 改动 | 证据 |
|---|---|---|---|
| #1 | 研发约定 v1 | 加两条：<br>- 导出函数的 JSDoc 必须有可运行的 @example，缺了视为未完成；<br>- docs/changes.md 是平台要求的交付说明，不算越界 | 3 条 |
| #2（已批准，生成 developer v2） | developer 模板 v1 | 提示词加一条：导出函数的 JSDoc 必须有可运行的 @example | 3 条 |

## 之前的运行（只作参考，都是 11/11）

| 日志 | 代码 | 不作为证据的原因 |
|---|---|---|
| `attempt1.log` | 运行期间我在修代码评审提出的问题 | 加载的代码版本不确定 |
| `attempt2.log` | `17d4082` | 还没有"调用工具就作废"和括号匹配 |
| `attempt3.log` | `b7e6ca1` | 第二轮独立审查之前的版本：正文里复述的格式示例可能顶替答案 |

四次运行里，improver 每次都把 @example 规则写进了 developer 模板和（或）研发约定。另外几条提案每次都不一样：
- 改 write-changes 技能；
- 改 standard 工作流里 spec 节点的说明；
- 在研发约定里说明 docs/changes.md 不算越界。

后两条针对的都是同一条评审意见（开发改了 docs/changes.md，被判为超出规格范围）。

## 没覆盖到的

- 生成的提案是否真的减少了评审轮次，要等前后对比，在 PR5 做。
- E2E 的数据目录在仓库里。独立审查发现 dsh 会把仓库的 CLAUDE.md 注入 improver 的会话，这一点已经写进 ADR-004 的已知限制。修复需要改 `dsh.ts`，另开 PR。
