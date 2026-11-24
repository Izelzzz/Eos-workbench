# 试用反馈第 3 条：日志和看得懂的失败原因（真实模型 E2E）

脚本：`scripts/logs-e2e.ts`。在 Node 24.22.3 上启动 `eos web`，用真实模型跑内置 standard 工作流，人为制造两种失败：

- **A**：规格调用进行中，结掉这个任务的 dsh 进程。按进程的工作目录 `<数据目录>/dsh/process-cwd` 找到它，不会碰别的进程。之后通过接口点「重试」。
- **B**：开发调用进行中，删掉任务的 worktree。

14/14 通过，见 `report.json`，提交 e02866d（处理独立审查之后的最终代码；之前在 471a22a 上也是 14/14）。

| | A（dsh 进程被结掉） | B（worktree 被删） |
|---|---|---|
| 哪一步 | `[spec] spec-writer · produce（调用 c1）` | `[build] developer · produce（调用 c3）` |
| 原因 | `dsh profile "sdk": DeepSeek Harness runtime exited` | `working-directory: directory does not exist: "…/worktrees/<任务>"` |
| 怎么修 | agent 进程意外退出：直接重试；反复出现时看日志里 dsh 的报错 | 任务的 worktree 被删除或损坏：确认 worktree 目录还在、主仓库里还有它的登记 |
| 之后 | 重试后任务跑完（done） | — |

## 文件

- `task-A.log`：任务 A 的日志文件原样。每行带 ISO 时间，有失败那一行、完整错误（`TransportClosedError`、dsh 的 stderr 尾部、堆栈），还有重试后完整跑完的进度。
- `eos.log`：Web 服务进程的日志（启动地址、各任务的进度行）。
- `A-failed-*.png`、`B-failed-*.png`：任务页的失败原因区，桌面 1440 宽和手机 390 宽。
- `steps.log`：脚本的步骤记录。

## 说明

- 第一次跑（提交 87c9638）是 12/12，但两种失败的「怎么修」都是「没有认出这个错误」：规则表里事先猜的报错文字，和 dsh 实际的报错对不上。规则补上了这两种真实报错（471a22a），E2E 也加了「认出了错误」这一项，重跑后 14/14。
- 规则表其余几类（401、402、429、网络、检查命令起不来）的报错文字没有实际触发过，只有单元测试。
