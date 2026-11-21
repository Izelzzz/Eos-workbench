# #32 修复证据：逐帧解压 dsh 会话日志

## 修复前

`run-before.log` 是第 3 块 PR1 时在 main 上跑的 `npm run e2e`，修复前的代码：

- **第 37 行**：开发完成后 SIGKILL 掉 runner。
- **第 41 行**：续跑时又出现「→ [build] developer · produce」。平台读 dsh 日志只读到第一帧，找不到已经完成的回复，把这次调用**重发**了一遍，多花了一次模型调用。
- E2E 报告里「开发的每次调用都在同一个 dsh 会话里」「规划和评审是只读档位」两项误报 false，原因相同：脚本读会话日志也只读到第一帧。

## 修复后

在 `fix/zstd-frames` 上用真实模型重跑 `npm run e2e`。`run-after.log` 是完整输出，`e2e-report.json` 是 E2E 报告。

- **第 27 行**：同样在开发完成后 SIGKILL 掉 runner。
- **续跑时**：日志里是「↺ [build] developer · produce：会话里已有这次调用的回复，直接使用」，没有重发。
- **报告 8/8 通过**，原来误报的两项也通过：
  - build 会话收到的调用是 `["c2", "c4"]`，c2 只有一次；修复前是 c2、c2、c4；
  - plan、review 的档位最后都是 read-only，build 是 workspace-write。

## 单测

`tests/executor.test.ts` 新增 3 个测试：

- 多帧日志能完整读出，最后一帧里的回复能找到；
- 尾帧被截断 1–39 字节时，都只丢最后一帧；跳过可跳过帧；最后一行 JSON 不完整时丢掉这一行；
- 执行器的 `findReply` 能认领写在后面帧里的回复。

把 `parseSessionLog` 换回旧的单帧解压，这 3 个测试都会失败。

另外用 `.eos/e2e` 里三个真实会话日志试过：完整解出 92、59、125 条事件；把文件尾部截掉 37 字节后，各自只少了最后一帧里的 3 条。
