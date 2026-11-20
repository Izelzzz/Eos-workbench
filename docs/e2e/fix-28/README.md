# #28 的证据：撤销越界改动时不会被 agent 的后台进程引到外面

## 竞态复现（`scripts/revert-race.ts`，不调模型）

一个进程不停地把 worktree 里的目录 `d` 在"真目录"和"指向 worktree 外 OUTSIDE 的链接"之间原子切换，平台同时循环撤销越界改动。同一个脚本：

| | 修复前（origin/main 的 git.ts） | 修复后 |
|---|---|---|
| 1000 轮里删到 worktree 外面的次数 | **3** | **0** |
| 拒绝提交（失败就关）的轮数 | — | 约 30%（竞态进行中，平台停下不提交，这是预期） |

文件：`race-before-1000.json`、`race-after-1000.json`。

## 后台作业探针（`scripts/background-probe.ts`，真实 dsh + 真实模型）

可写角色的能力面下让 agent 试着起后台作业，`background-probe.json` 5 项全过：
- 工具表里没有 `job_*` 工具（来自会话日志里真正发给模型的工具表）；
- `run_in_background` 被 dsh 拒绝（"run_in_background is disabled for this deployment"）；
- 用 `nohup ... &` 在前台命令里放到后台的进程，这一轮结束时确实还活着；平台清理之后不在了；
- 清理后下一次调用正常（重启 dsh、续接会话）。

耗时：清理（关 dsh + 扫 /proc）76ms；下一次调用（重启 dsh、续接会话、加一句简短回复）约 3.9 秒。

## 第 2 块 E2E 回归（`templates-e2e/`，真实模型，全程浏览器）

#28 的代码上重跑第 2 块的 E2E：15/15。报告里的提交号是 2a887af（运行中途提交了只改 CLAUDE.md 的提交，代码不变）。这一次评审多走了两轮（4 轮），总耗时 4 分 40 秒，和第 2 块最后一次（2 轮、3 分 7 秒）不直接可比；每一步的额外开销以探针的实测为准。
