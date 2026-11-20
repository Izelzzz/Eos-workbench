# PoC：用 DeepSeek Harness 当 Eos 平台的执行内核

**这是一次性的验证代码，不是正式实现。** 它要回答一个问题：Eos 平台能否通过 dsh 的 SDK 驱动 agent，并满足对话循环、主动提问、写入范围和可观测这几项需求。

- 验证对象：`@deepseek-ai/dsh@0.2.2-rc.5`，SDK 客户端取自源码 main 分支 `2e39e704`（2026-11-18）
- 运行环境：Node 24.22.3，模型 `deepseek-v4-flash`，Linux 容器（未安装 bwrap）
- 重跑方法：`./run-all.sh`，日志写入 `logs/`

## 结论

| # | 验证目标 | 结果 | 证据 |
|---|---|---|---|
| 1 | 用 SDK 驱动 | 通过 | `logs/p1-run.log`：`finishReason: completed`，用时 4.8 秒，事件流里有 `usage` |
| 2 | 会话续接 | 通过 | `logs/p2-resume-*.log`：宿主进程被 SIGKILL 杀掉后，`resumeSession` 恢复同一个 session id，模型答出了之前记下的暗号 |
| 3 | 外部执行器（Claude Code） | **不满足需求** | 源码 README：`subagent-claude-code`、`-codex`、`-acp`、`-dsh-sdk` 都是"每次运行一个全新 query，不支持续接、恢复或追加输入"。没有 Anthropic key，所以没有实际运行 |
| 4 | 写入范围 | 通过，但有漏洞 | `logs/p4-scope.log`：写 `/home/user/...` 被拒绝（`file access denied under workspace-write mode`），写工作区内成功。之前一次手动运行里，写真实的 `/tmp` 成功了 |
| 5 | 可观测 | 通过 | `logs/p5-observe.log`：从磁盘上只追加的 `session.v4.jsonl.zstd` 还原出每一步的耗时、token 和工具调用，`seq` 严格递增 |
| 6 | 主动提问 | 通过 | `logs/p3-ask.log`：agent 调用 `ask_user_question` 发出带两个选项的结构化问题，宿主 3 秒后回答，agent 继续执行并写入了 `color.txt` |

## 对设计的影响

1. **外部 agent 由平台直接驱动，不经过 dsh。** 开发↔评审的对话循环要求开发会话一直保持，而 dsh 的外部 subagent 每次都是全新会话。平台需要一层"执行器适配器"，统一提供 `start` / `send` / `resume` / `events` / `ask` 这几个接口：
   - dsh 原生 agent 用 dsh SDK（本次已验证）；
   - Claude Code 用 Claude Agent SDK（它支持按 session id 续接，本次未验证）；
   - Codex 用它的 app-server 或 `exec resume`（本次未验证）。
2. **部署镜像必须装 `bubblewrap`，worktree 不放在 `/tmp` 下。** 没有 bwrap 时 dsh 退到 Landlock，而 Landlock 允许写真实的 `/tmp`；有 bwrap 时 `/tmp` 是私有挂载。
3. **沙箱拒绝会附带"可申请提权"提示。** 提权请求会经过审批回调，可以接到"agent 主动问用户"的同一条通道上。
4. **主动提问天然支持异步。** dsh 的问题有 `open` / `continued` 两种状态：用户迟迟不回答时，答案会作为新的一轮到达。所以 Web 上"待我回答"的问题可以挂几个小时再回复。
5. **单轮固定开销约 9k 输入 token**（系统提示词和工具定义），第二次起大部分命中缓存（`cacheReadTokens: 8320`）。按节点统计成本时要把缓存读写分开算。

## 还没证明的

| 内容 | 原因 |
|---|---|
| Claude Code、Codex 能否多轮续接 | 没有 Anthropic / OpenAI key；只根据 dsh 源码排除了"经 dsh 调用"这条路，直接驱动的方案还没跑过 |
| 装了 bwrap 后 `/tmp` 的写入被隔离 | 容器里没有 bwrap，结论只来自 dsh 的文档 |
| 长时间挂起的提问（`continued` 状态） | 本次只测了 3 秒内回答的情况 |
| 冷启动耗时 | 有一次初始化超过了 10 秒（worker 重启后），已把超时调到 60 秒，原因没有深究 |
| 并发多个 session 时的资源占用 | 本次只跑了单个 session |
