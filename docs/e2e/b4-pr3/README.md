# 第 4 块 PR3：生成改进提案 E2E（真实模型）

脚本：`scripts/improve-e2e.ts`。命令：`node --import tsx scripts/improve-e2e.ts`。

## 做法

场景和 PR1、PR2 一样：团队规则「导出函数要有带 @example 的 JSDoc」只写进 reviewer 模板第 2 版，开发看不到。

1. 并行跑 3 个 standard 任务（sum、max、avg）。agent 提问时自动回答，任务失败时自动重试。全部结束后关掉 web。
2. 用命令行运行 `eos improve --workflow standard`，调用真实的 improver。
3. 用 `eos approve <id>` 批准，再用 `eos proposals` 查看结果。

## 结果

用的是最终代码 `b7e6ca1`，也就是处理完独立审查之后的版本。这一版里，improver 只要调用任何工具，这次生成就作废。文件：`report.json`、`run.log`。

11 项核对全部通过：

- 3 个任务都完成，任务里有证据。共 3 条证据，都是 `review_changes`，被评判的角色都是 developer。
- `eos improve` 成功，生成 3 条提案。生成的过程中没有改任何约定。这也说明 **improver 没有调用任何工具**，否则这次生成会作废。
- 每条提案：
  - 引用的证据都是程序归纳出来的；
  - 目标都是有证据的约定，并且基于当前版本；
  - 内容能通过保存校验，没有改权限；
  - 记下了生成它的模型调用。
- 至少一条提案把 @example 规则写进 developer 模板或约定文档。
- `eos approve` 生成新版本，备注写明提案号；`eos proposals` 显示已批准。

improver 只调用了一次：16.3 秒，输入 3680 token，输出 3101 token。三条提案相对当前版本的改动：

| 提案 | 目标 | 改动 | 证据 |
|---|---|---|---|
| #1 | developer 模板 v1 | 提示词加两条：导出函数的 JSDoc 必须有 @example（正常用法和边界各一例）；提交前对照验收标准和团队约定自查 | 3 条 |
| #2（已批准，生成研发约定 v2） | 研发约定 v1 | 代码约定加一条：导出函数的 JSDoc 必须有 @example（正常用法和边界各一例） | 3 条 |
| #3 | standard 工作流 v1 | 只改 spec 节点的 `task` 文字：验收标准如果限定了允许改动的文件，要把 docs/changes.md 列进去。没有改角色、节点和检查命令，所以权限核对通过 | 1 条，是评审在 @example 之外指出的另一个问题 |

## 之前的运行

前两次运行都是 11/11，只作参考，不作为证据：

- `attempt1.log`：第一次运行期间我在修代码评审提出的问题，命令行子进程加载的代码版本不确定。
- `attempt2.log`：用 `17d4082` 跑的。那一版还没有"调用工具就作废"和括号匹配解析。

三次运行，improver 都把 @example 规则写进了 developer 模板和研发约定。第三条提案每次不同：第 2 次改的是 write-changes 技能，第 3 次改的是 standard 工作流。

## 没覆盖到的

- 生成的提案是否真的减少了评审轮次，要等前后对比，在 PR5 做。
- E2E 的数据目录在仓库里。独立审查发现 dsh 会把仓库的 CLAUDE.md 注入 improver 的会话，这一点已经写进 ADR-004 的已知限制。修复需要改 `dsh.ts`，另开 PR。
