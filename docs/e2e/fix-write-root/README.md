# 写入范围修复的证据

`scripts/scope-probe.ts`：真实 dsh + 真实模型。可写角色分别往自己任务的 worktree、平台启动目录、别的任务的 worktree 写文件，只读角色往自己的 worktree 写；每处都用 write 工具和 bash 各写一次，以磁盘上实际有没有文件为准。目录都在 `.eos/` 下（不在 `/tmp`，没有 bwrap 时 Landlock 放行真实的 `/tmp`）。

| | 修复前（origin/main b18464b） | 修复后（be253aa） |
|---|---|---|
| 可写角色 → 自己任务的 worktree | ✗ 被拒绝 | ✓ 写入 |
| 可写角色 → 平台启动目录 | ✗ 写入 | ✓ 被拒绝 |
| 可写角色 → 别的任务的 worktree | ✓ 被拒绝 | ✓ 被拒绝 |
| 只读角色 → 自己任务的 worktree | ✓ 被拒绝 | ✓ 被拒绝 |

修复前那次运行的 `uncommitted` 里只有 `scripts/scope-probe.ts`：探针脚本是修复时新写的，复制到修复前的代码里运行。

## 修复后的完整流程

`pipeline-e2e/`：修复后（4783079）重跑第 1 块的 Web 端到端（真实模型），10 项全部通过。每个任务现在有自己的 dsh 进程，进程在 worktree 里运行；`task-branch-files.txt` 是任务分支相对 main 的改动文件，只有 agent 按任务写的 4 个文件，没有 dsh 自己的文件混进提交。
