# vendor/dsh-sdk-client

DeepSeek Harness 的 TypeScript SDK 客户端源码，原样复制自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/sdk/client/src/`，MIT 协议（见 `LICENSE`）。

- 来源提交：`2e39e704`（2026-11-18），包版本 `0.2.2-rc.5`，与 `package.json` 里锁定的 `@deepseek-ai/dsh` 一致
- 为什么放在这里：npm 上的 `@deepseek-ai/dsh-sdk-client` 只发布到 `0.0.1-rc.1`，与运行时版本不匹配
- 不要修改这些文件。升级 dsh 时整体替换，并重跑 `poc/run-all.sh`
- 只有 `src/executor/dsh.ts` 可以引用它
