# ADR-001：自部署的多 agent 工作流平台，以 dsh 为执行内核

- 状态：已采纳（2026-11-20）。PoC 阶段的验证记录；和 `docs/roadmap.md` 冲突时以路线图为准
- 读者：要理解平台整体结构的人
- 关联：ADR-002（团队约定和检查）、ADR-003（Agent 模板）、ADR-006（部署和沙箱）

## 背景

- Eos 原先是一个 Claude Code 插件：六个阶段固定在状态机里，只能在一个 Claude Code 会话中运行，阶段之间只能「打回重跑」。
- 同类产品里，LoopForge 有「角色 + SOP + 人工关口 + 多种 CLI」，Multica 把 agent 当作看板上的队友。两者都没有让开发和评审在同一个会话里来回对话。
- DeepSeek Harness（dsh，0.2.2-rc.5 开发者预览）提供 agent 运行时，可以通过 SDK 驱动。PoC 验证了它支持：会话续接、主动提问、写入限制、从只追加的日志重建用量。
- PoC 同时发现两点限制：dsh 的外部 subagent（Claude Code、Codex、ACP）每次都是全新会话，不能多轮续接；没有 bwrap 时，真实的 `/tmp` 可写。

## 目标

个人或小团队自部署。用户在 Web 上发起任务，平台按工作流运行，多个职责不同的 agent 在对话中协作完成任务。

1. 部署后在 Web 上配置模型 key，可以连接本地仓库或 GitHub 仓库（克隆、推送任务分支、开 PR）。
2. 角色可以配置提示词、模型、技能、工具和写入范围，越界写入被拒绝并记录。
3. 执行器接口按多种执行器设计。
4. 评审和开发、测试和开发是对话循环：最多 5 轮；不通过时交给上游 agent 重新确认做法和需求；仍不通过就向用户提问。
5. 不预设人工关口。每个 agent 都能主动向用户发起结构化提问，问题集中在「待我回答」列表里。
6. 后端进程重启后，进行中的任务从最后一个检查点继续，不重复执行已完成的 agent 回合。
7. 每个 agent 的会话日志只追加不改写；任务详情可以回放对话、工具调用和产物，并按节点、按角色统计耗时和 token（缓存读写分开计）。
8. 引擎状态机做穷举验证。

不做：IM 或 Git 事件触发、多租户和 RBAC、可视化工作流设计器、K8s 和容器级隔离、动态调度。

## 设计

### 总览

| 部分 | 设计 |
|---|---|
| 平台层 | 自建，TypeScript（Node 24） |
| 工作流引擎 | 纯函数 reducer：输入事件，输出新状态和要执行的 effect |
| runner | 执行 effect，把结果作为事件送回引擎 |
| 存储 | 事件只追加地存进 SQLite（`node:sqlite`），状态随事件快照保存 |
| 执行内核 | dsh，通过 stdio JSON-RPC 的 SDK 调用 |
| 执行器接口 | `src/executor/types.ts` 的 `Executor`；dsh 是唯一已接入的实现 |

### 引擎：reducer 和 effect

- 引擎不读写文件、不访问网络、不读时钟。所有外部动作都表达为 effect，由 runner 执行。
- 状态只有一个来源。崩溃恢复就是「重放事件、补跑未完成的 effect」。
- 状态空间可以穷举验证（`tests/engine.state-space.test.ts`）。

**为什么不用命令式的 async 流程加检查点**：代码更少，但恢复时要从函数中间重新进入，也无法穷举验证。

**为什么编排状态由平台掌握**：dsh 自带的 workflow 没有检查点，进程重启后状态丢失。

### 执行内核：dsh

- dsh 只作为执行内核，版本锁定为 `0.2.2-rc.5`。不 fork dsh。
- SDK 客户端的源码放在 `vendor/dsh-sdk-client`，因为 npm 上同版本的客户端没有发布。
- 只通过 SDK 接入 dsh，把它的破坏性变更限制在执行器适配器之内。

### 执行器接口

- 接口统一提供这几个能力：打开会话、发消息、续接、查已有回复、提问回调。
- 每种执行器只在 `src/executor/` 下自己的文件里接入。别的模块只依赖 `Executor` 接口。
- 外部 agent（例如 Claude Code）由平台直接驱动，不经过 dsh 的 subagent。原因：dsh 的 subagent 不支持多轮续接。

### 对话循环

- 被评审的一方（例如开发）在整个任务里只用一个会话。
- 评审方在一次对话节点内保持同一个会话。
- 每一轮由评审方给出结构化结论：`pass` 或 `changes`。
- 最多 5 轮；之后请上游重新确认；仍不通过时向用户提问。

对话式评审循环是和 LoopForge 的差异点。dsh 的会话续接和主动提问支撑这一设计。

### effect 幂等

- 每条发给 agent 的消息都带一个 nonce。
- 重启后，平台先在 dsh 的会话日志里查这个 nonce 对应的回复。查到就直接使用，查不到才重发。

### 写入范围

- 写入范围用 dsh 的权限档位实现：`read-only` 或 `workspace-write`。
- 任务的 worktree 放在平台数据目录下，不放在 `/tmp`。原因：没有 bwrap 时 `/tmp` 不受沙箱限制。
- 路径级的写入范围（`writePaths`）见 ADR-003；容器里的沙箱见 ADR-006。

**每个 worktree 一个 dsh 进程**

- dsh 在创建会话时，把 dsh 进程的工作目录记为会话的工作区。`workspace-write` 只允许写这个工作区，之后再设置工作目录不会改变它。
- 因此每个 worktree 用一个 dsh 进程，会话的工作区是这个 worktree。
- 续接会话前，平台核对会话头里的工作区。不是任务的 worktree 时拒绝续接。
- dsh 进程自己的工作目录是平台数据目录里的一个空目录。原因：dsh 启动时会读进程目录下的 `.env`，不能让仓库或 agent 写的 `.env` 影响它。

**agent 不能自己提交**

- git worktree 的索引和对象在主仓库的 `.git/` 下，不在可写范围内。agent 执行 `git add`、`git commit` 会失败。
- 提交由平台负责，所以不受影响。

## 和目标的差距

| 目标 | 现状 |
|---|---|
| 内置功能开发、Bug 修复两个工作流模板 | 内置的是 `feature` 和 `standard`，没有 Bug 修复模板 |
| 用户在对话里描述流程，由工作流设计 agent 生成或修改 YAML，渲染成流程图 | 没有做 |
| 接入 Claude Code 和 Codex 执行器 | 只有 dsh。Claude Code 的 PoC 已完成（`poc/claude-code/`），没有接入 |

## 没有采用的方案

| 方案 | 不采用的原因 |
|---|---|
| fork LoopForge | Go 代码量大，做出来是同质产品 |
| 经 dsh 的 subagent 接外部 agent | 不支持多轮续接 |
| 继续做 Claude Code 插件 | 无法自部署，也不能多人使用 |
| 命令式 async 流程加检查点 | 恢复时要从函数中间重新进入，无法穷举验证 |

## 已知限制

| 限制 | 说明 |
|---|---|
| 依赖 dsh 的预览版 | dsh 只有 alpha 和 rc 版本。升级 dsh 前要重跑 `poc/run-all.sh` 和 E2E |
| 隔离只适合可信的个人或小团队 | agent 和平台共享内核，不是多租户边界。部署下的隔离见 ADR-006 |
| 默认模型是 `deepseek-flash` | 可以按角色选模型和 effort |

## 重新评估的条件

- dsh 的 SDK 协议或会话日志格式发生不兼容的变更。
- 外部 agent 无法由平台直接驱动并多轮续接。
- 对话循环在真实任务里的通过率明显低于「打回重跑」。

## 证据

| 结论 | 证据 |
|---|---|
| dsh 支持会话续接、主动提问、写入限制、从日志重建用量 | `poc/README.md` |
| 每个 worktree 一个 dsh 进程后，可写范围是任务的 worktree | `scripts/scope-probe.ts`、`docs/e2e/fix-write-root/` |
