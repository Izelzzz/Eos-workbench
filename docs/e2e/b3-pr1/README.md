# 第 3 块 PR1：阶段指标 E2E 证据

在 `feat/obs-stage-metrics` 的 0823258 上跑 `npm run e2e`（真实 deepseek-flash，任务中途 SIGKILL 后续跑），然后用 `eos log` 看这个任务。

| 文件 | 内容 |
|---|---|
| `eos-log-tail.txt` | `npm run eos -- --data .eos/e2e/data log t261120213243xas` 末尾的阶段表 |
| `raw-log.txt` | 从数据库直接读出的调用、提问、回答时间戳，用来手算核对阶段表 |
| `e2e-report.json` | E2E 脚本的报告 |

## 手算核对

- plan：调用 c1 耗时 54015ms；调用中途 3 次提问，等回答 247 + 224 + 296 = 767ms → agent 53248ms（53.2s），等用户 767ms，总 54.0s。
- review：c3 + c4 + c5 = 44222 + 13505 + 9994 = 67721ms；从 c3 开始到 c5 结束 67834ms → 平台开销 113ms。
- 任务总时长：c1 开始 1795210366329 到 c5 结束 1795210519550 = 153221ms（2m33s）；各阶段合计 129.6s，差 23.6s：plan 结束到 build 开始 21.4s（E2E 在这里杀掉 runner 再续跑），build 结束到 review 开始 2.3s。

## E2E 报告里两项 false 的原因

`开发的每次调用都在同一个 dsh 会话里`、`规划和评审是只读档位` 两项为 false，是 E2E 脚本读 dsh 会话日志的方式有问题，不是这次改动造成的：dsh 把会话日志写成多个连续的 zstd 帧，Node 22 的 `zstdDecompressSync` 只解出第一帧（106KB 的文件只解出 216 字节的头）。逐帧解压后：

- build 会话收到 c2、c2、c4（c2 两次是杀进程后重发），开发的调用都在同一个会话里；
- plan、review 会话的档位最后都是 read-only，build 是 workspace-write。

`src/executor/dsh.ts` 的 `readLog`（崩溃续跑时读回复）用的是同一种读法，另开 issue 修。
