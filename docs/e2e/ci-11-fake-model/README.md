# CI 确定性 E2E（假模型）的证据

两次运行都在提交 `bff55d9` 上，同一份 `scripts/e2e.ts` 和同样的 8 项核对。

- `real-model/`：真实模型（`npm run e2e`，deepseek-flash，5 次调用）。本 PR 改了 `src/executor/dsh.ts`（交给 dsh 的环境变量），按 CLAUDE.md 跑一次真实模型，确认平时的路径没有受影响：没设 `EOS_MODEL_BASE_URL` 时 dsh 照常连真实的模型接口。
  - `run.log`：完整输出；`report.json`：核对结果，8 项全部通过。
- `fake-model/`：确定性 E2E（`node --import tsx scripts/e2e-ci.ts`），不调真实模型，和 CI 的 `e2e-fake-model` job 跑的是同一个脚本。
  - `e2e-ci-stdout.txt`：完整输出；`report.json`：核对结果，8 项全部通过；`fake-model.log`：假模型收到的 14 个请求和它的回复。
