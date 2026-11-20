# #28 的证据：撤销越界改动时不会被 agent 的后台进程引到外面

## 竞态复现（`scripts/revert-race.ts`，不调模型）

一个进程（先 `cd /`，躲开撤销前按工作目录的进程清理）不停地把 worktree 里的目录 `d` 在"真目录"和"指向 worktree 外 OUTSIDE 的链接"之间原子切换，平台同时循环撤销越界改动。两个场景：delete（越界的新文件要删掉）、restore（越界改过的已跟踪文件要写回 HEAD 的内容）。同一个脚本，每个场景 1000 轮，碰到外面文件的轮数：

| | delete | restore（写回） |
|---|---|---|
| 修复前（origin/main 的 git.ts） | 1 | **4** |
| 只修了删除（#28 独立审查指出的缺口） | 0 | **3** |
| 三层都修 | **0** | **0** |

拒绝提交（失败就关）的轮数很多（写回场景几乎每轮），这是预期：竞态进行中平台停下，不提交。文件：`race-before-1000.json`（前两行）、`race-after-1000.json`。

## 后台作业探针（`scripts/background-probe.ts`，真实 dsh + 真实模型）

可写角色的能力面下让 agent 试着起后台作业，`background-probe.json` 5 项全过：
- 工具表里没有 `job_*` 工具（来自会话日志里真正发给模型的工具表）；
- `run_in_background` 被 dsh 拒绝（"run_in_background is disabled for this deployment"）；
- 用 `nohup ... &` 在前台命令里放到后台的进程，这一轮结束时确实还活着；平台清理之后不在了。注意：报告里 `killed` 是空的——这个进程是关掉 dsh 时被 dsh 结束子进程组带走的，不是 `/proc` 扫描杀的；`setsid` 脱离进程组的情况只有单元测试覆盖（`tests/procs.test.ts`，进程由测试直接启动，不在 dsh 下面）；
- 清理后下一次调用正常（重启 dsh、续接会话）。

耗时：清理（关 dsh + 扫 /proc）76ms；下一次调用（重启 dsh、续接会话、加一句简短回复）约 3.9 秒。

## 第 2 块 E2E 回归（`templates-e2e/`，真实模型，全程浏览器）

#28 的最终代码（d78ce51，含审查修复）上重跑第 2 块的 E2E：15/15。README.md 的越界改动这次走的是新的"在核对过的目录里写回"。
