# 写入范围修复的证据

## 探针

`scripts/scope-probe.ts`：真实 dsh + 真实模型。

- 布局和实际部署一样：进程从 `host` 目录启动，任务的 worktree 用 `git worktree add` 建在 `host/data/worktrees/` 里面。
- 可写角色分别往自己任务的 worktree、平台启动目录、别的任务的 worktree 写文件，只读角色往自己的 worktree 写；每处都用 write 工具和 bash 各写一次，以磁盘上实际有没有文件为准，不看 agent 怎么说。
- 任务的 worktree 里放了一个含 `PATH=/nope` 的 `.env`（dsh 启动时会读进程目录下的 .env，见独立审查 A1）。
- 目录都在 `.eos/` 下，不在 `/tmp`（没有 bwrap 时 Landlock 放行真实的 `/tmp`）。

修复前后用的是同一个脚本，两次运行时的 SHA-256 都是 `bd93d775f4022ad4728152495449c6185a21cba53e92dc6a3f10d7a8ab3bafdc`（脚本是修复时新写的，复制到修复前的代码里运行，所以修复前那份报告的 `uncommitted` 里有它）。

| | 修复前（origin/main b18464b） | 修复后（6c965a4） |
|---|---|---|
| 可写角色 → 自己任务的 worktree | ✓ 写入 | ✓ 写入 |
| 可写角色 → 平台启动目录 | ✗ **写入** | ✓ 被拒绝 |
| 可写角色 → 别的任务的 worktree | ✗ **写入** | ✓ 被拒绝 |
| 只读角色 → 自己任务的 worktree | ✓ 被拒绝 | ✓ 被拒绝 |
| worktree 里有 `PATH=/nope` 的 .env，agent 照常启动 | — | ✓ |

文件：`before-origin-main.json`、`after-fix.json`。

更早的一版探针（worktree 用 `git init` 建在启动目录之外）结果是：修复前可写角色写不了自己的 worktree、却能写启动目录；修复后正确。两种布局下修复前都是错的，错法不同。

## 修复后的完整流程

`pipeline-e2e/`：修复后重跑第 1 块的 Web 端到端（真实模型），见该目录的 `report.json`。`task-branch-files.txt` 是任务分支相对 main 的改动文件，只有 agent 按任务写的文件，没有 dsh 自己的文件混进提交。

注意：这个 E2E 的数据目录在平台启动目录之内，修复前也能通过；它证明的是修复没有带来回归，不能区分修复前后。区分修复前后的是上面的探针。
