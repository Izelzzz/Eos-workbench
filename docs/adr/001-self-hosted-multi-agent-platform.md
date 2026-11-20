# ADR-001：Eos 重写为自部署的多 agent 工作流平台，以 DeepSeek Harness 为执行内核

- 状态：已接受（2026-11-20）
- 取代：Eos 作为 Claude Code mod 的全部设计

## 背景

- Eos 原先是一个 Claude Code mod：六个阶段写死在状态机里，只能在一个 Claude Code 会话中运行，阶段之间只能"打回重跑"。
- 同类产品里，LoopForge（腾讯，MIT）已有"角色 + SOP + 人工关口 + 多种 CLI"，Multica 把 agent 当作看板上的队友。两者都没有让开发和评审在同一个会话里来回对话。
- DeepSeek Harness（dsh，MIT，0.2.2-rc.5 开发者预览）提供 agent 运行时，可以通过 SDK 驱动。PoC（`poc/README.md`）已验证它能做到：会话续接、主动提问、`workspace-write` 写入限制、从只追加的日志重建用量。
- PoC 同时发现两点：dsh 的外部 subagent（Claude Code、Codex、ACP）每次都是全新会话，不能多轮续接；没有 bwrap 时，真实的 `/tmp` 可写。

## 目标

个人或小团队用 Docker Compose 自部署。用户在 Web 上发起任务，平台按工作流运行，多个职责不同的 agent 在对话中协作完成任务。

验收标准：

1. `docker compose up` 后在 Web 配置模型 key，可以连接本地仓库或 GitHub 仓库（克隆、推送任务分支、开 PR）。
2. 内置功能开发、Bug 修复两个模板。用户在对话里描述流程，由工作流设计 agent 生成或修改 YAML，平台校验后渲染成流程图，用户确认后生效。
3. 角色可以配置提示词、模型、skills、工具白名单和写入范围，越界写入会被拒绝并记录。
4. 第一阶段所有角色都是 dsh 原生 agent，默认模型 `deepseek-flash`（DeepSeek-V4.1-Flash），可按角色选模型和 effort。执行器接口按多执行器设计，第二阶段接入 Claude Code 和 Codex。
5. 评审↔开发、测试↔开发是对话循环：最多 5 轮；不通过时交给上游 agent 重新确认做法和需求；仍不通过就向用户提问。三条路径都有测试覆盖。
6. 不预设人工关口。每个 agent 都能主动向用户发起结构化提问，问题集中在"待我回答"列表里。
7. 后端进程重启后，进行中的任务从最后一个检查点继续，不会重复执行已完成的 agent 回合。
8. 可观测性参考 dsh：每个 agent 的会话日志只追加不改写；任务详情可以回放对话、工具调用和产物，并按节点、按角色统计耗时和 token（缓存读写分开计）。
9. 引擎状态机做穷举验证。
10. E2E：在示例仓库上跑完功能开发模板，至少经历 1 次评审打回、1 次对话修复和 1 次主动提问，留下截图和日志。

不做（第一版）：IM / Git 事件触发、多租户与 RBAC、可视化工作流设计器、K8s 与容器级隔离、动态调度。

## 决定

- **平台层自建**，TypeScript（Node 24）。工作流引擎是纯函数 reducer：输入事件，输出新状态和要执行的 effect。runner 执行 effect，并把结果作为事件送回 reducer。事件只追加地存进 SQLite（`node:sqlite`），状态随事件快照保存。
- **dsh 只作为执行内核**，通过 stdio JSON-RPC SDK 调用，版本锁定为 `0.2.2-rc.5`。SDK 客户端源码按 MIT 协议放在 `vendor/dsh-sdk-client`，因为 npm 上同版本的客户端没有发布。不 fork dsh。
- **执行器适配器**统一提供"打开会话、发消息、续接、查已有回复、提问回调"这几个能力。dsh 原生 agent 是第一个实现。外部 agent 将来由平台直接驱动（例如 Claude Agent SDK），不经过 dsh 的 subagent。
- **对话循环**：被评审的一方（例如开发）在整个任务里只用一个会话；评审方在一次对话节点内也保持同一个会话。每一轮由评审方给出结构化结论（`pass` / `changes`）。
- **effect 幂等**：每条发给 agent 的消息都带一个 nonce。重启后，先在 dsh 会话日志里查这个 nonce 对应的回复；查到就直接使用，查不到才重发。
- **写入范围**：用 dsh 的权限档位实现（`read-only` / `workspace-write`）。部署镜像必须安装 bubblewrap；任务 worktree 放在平台数据目录下，不放在 `/tmp`。
  - 2026-11-20 更正：dsh 在创建会话时把 dsh 进程的 cwd 记成会话的工作区，`workspace-write` 只允许写这个工作区，之后设工作目录不会改变它。最初的实现所有任务共用一个 dsh 进程、没有设 cwd，可写范围实际是平台的启动目录（开发 agent 能改平台自己的文件，而写不了不在启动目录下的 worktree）。已改为每个 worktree 一个 dsh 进程，cwd 设为 worktree；`scripts/scope-probe.ts` 用真实 dsh 验证，修复前后的结果在 `docs/e2e/fix-write-root/`。
  - dsh 进程自己的工作目录是平台数据目录里的空目录（dsh 启动时会读进程目录下的 .env，不能让仓库或 agent 写的 .env 影响它）；续接会话前核对会话头里的工作区，不是任务的 worktree 就拒绝续接。
  - 副作用：git worktree 的索引和对象在主仓库的 `.git/` 下，不在可写范围内，agent 自己执行 `git add`/`git commit` 会失败。提交本来就由平台负责（开发角色的提示词也这样要求），所以不受影响。

## 为什么这样做

- 编排状态由平台掌握并落库，进程重启后可以继续跑；dsh 自带的 workflow 没有检查点，重启就丢。
- reducer + effect 的形状让状态只有一个来源。崩溃恢复就是"重放事件、补跑未完成的 effect"，而且状态空间可以穷举验证。对比过的另一种做法是命令式 async 流程加检查点：代码更少，但恢复时要从函数中间重新进入，也没法穷举验证，所以没有采用。
- 和 LoopForge 的差异点是对话式评审循环；dsh 的会话续接和主动提问正好支撑这一点。
- 只通过 SDK 接入 dsh，把它的破坏性变更挡在适配器之内。

不采用的方案：
- fork LoopForge：Go 代码量大，做出来是同质产品；
- 经 dsh subagent 接外部 agent：不支持多轮续接；
- 继续做 Claude Code mod：无法自部署，也不能多人使用。

## 影响范围

| 范围 | 影响 |
|---|---|
| 代码 | 整个仓库重写：删除 mod 代码（`hooks/`、`tests/`、`types/`、`.claude-plugin/`）和旧 skill，新增 `src/`、`vendor/`；旧 `.eos/` 任务数据不迁移 |
| 约定 | 重写 `CLAUDE.md` 和 `README.md`，自检改为类型检查、单元测试、状态机穷举测试、代码评审和 E2E |
| 依赖 | 依赖 dsh 0.2.2-rc.5 和 DeepSeek API；升级 dsh 前要重跑 `poc/run-all.sh` 和 E2E |
| 部署 | Docker 镜像需要 Node 24 和 bubblewrap；数据目录持久化（SQLite、dsh home、worktree） |
| 安全 | 写入隔离依赖 bwrap，和宿主共享内核，只适合可信的个人或小团队，不是多租户边界 |
| Issue | 旧 issue 已全部关闭；新工作按里程碑 M1 到 M5 开 issue |

## 重新评估的条件

- dsh 的 SDK 协议或会话日志格式发生不兼容变更；
- 外部 agent 无法由平台直接驱动并多轮续接；
- 对话循环在真实任务里的通过率明显低于"打回重跑"。
