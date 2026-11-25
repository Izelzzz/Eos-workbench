# killProcessesIn 等待条件（#68）：E2E 证据

运行：`npm run e2e`，在提交 86aaa9d 上单独跑一次，没有别的测试同时在跑。结果 8/8（`e2e-report.json`），共 5 次模型调用（`e2e-run.log` 末尾的「合计」）。

## 这次 E2E 证明了什么、没证明什么

- 证明了：改动之后任务照常跑完，包括杀进程续跑、评审对话、worktree 里的 `npm test`。
- 没证明：`killProcessesIn` 只在撤销越界改动前调用。这次运行里没有越界改动，日志里没有「结束了…进程」，所以 E2E 没有走到改动的代码。这部分的证据是 `tests/procs.test.ts` 的单元测试、变异验证，以及真实进程上的压测（见 PR 描述）。
