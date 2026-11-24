# 凭据存储内核（路线图 P0 第 1 项，PR 1）E2E 证据

运行命令：`node --import tsx scripts/master-key-probe.ts`。

探针随机生成一个主密钥，带着它跑一遍真实模型的 `npm run e2e`（deepseek、feature 模板，中途杀掉进程再续跑）。运行期间，探针每 50ms 扫一遍 `/proc`，记下每个进程的父进程，以及它的环境变量里有没有这个主密钥。

| 文件 | 内容 |
|---|---|
| `e2e-report.json` | E2E 自己的 8 项核对，全部为 true |
| `e2e-run.log` | E2E 的完整输出 |
| `master-key-probe.json` | 探针结果：每个带主密钥的进程属于哪一类，以及平台起的子进程看到了多少个 |

## 结论

- 平台（`src/cli.ts`）起的子进程共看到 56 个，其中 dsh 5 个、检查命令（`npm test`、`node --test`）19 个。**这些子进程的环境里都没有主密钥**（`leaks: []`）。
- 环境里带着主密钥的进程只有两类：
  - 平台进程自己（`platform`）。平台启动时环境里就有主密钥，读出后从环境删掉，也改不了 `/proc/<pid>/environ`。这是已知限制，见 ADR-005。
  - E2E 驱动脚本那一支（`driver`），即建示例仓库的 git 和最后核对用的 `npm test`。它们不是平台起的。
- 上一次运行看到 tsx 的 esbuild 服务带着主密钥，这次没有看到。它和平台进程属于同一类暴露。

## 局限

- 探针按 50ms 间隔采样，活不到一个间隔的短命进程可能没被看到。子进程不继承主密钥这一点，另由 `tests/credentials.test.ts` 的最后一个测试确定性地验证。
