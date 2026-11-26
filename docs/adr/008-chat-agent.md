# ADR-008：对话 agent——只读平台数据，经平台的 MCP 端点交给 agent

- 状态：已采纳（2026-11-26），内容按当前实现维护
- 读者：要理解或修改对话 agent、或者要换执行器的人
- 关联：ADR-004（improver 的权限做法）、ADR-005（凭据和遮蔽）、ADR-006（部署里的用户）、路线图第 16 项（任务之间的隔离）、第 18 项（执行器解耦）

## 背景

- 用户想要一个和通用对话 agent 一样的入口，用来问平台上的东西、设计工作流。它要能读平台上所有的数据和规范。
- 已经确认的范围：
  - 能读工作流、约定文档、Agent 模板、技能、任务列表，单个任务的状态、trace、指标、改动摘要。不读仓库代码，任何情况下都读不到凭据。
  - agent 只能提议，不能自己保存（「加严容易、放宽要人批」）。提议和保存在后面的 PR 里做。
  - 现在没有登录，能打开平台的人都能和它对话。
- 难点：dsh 自带的文件读写、搜索工具，现在的角色关不掉（只能按工具组关命令行、联网等）。它们开着时，agent 能读数据目录（数据库、所有仓库、所有 trace）和仓库代码。

## 目标

- 对话 agent 不绑定任务，可以多轮对话。对话记录存进数据库，平台重启后能接着聊。
- agent 只有平台提供的只读工具，没有执行器自带的任何工具。
- 工具返回的内容先遮蔽已知凭据值。
- 对话的模型调用记进 trace 和指标，用单独的用途名 `chat`，不混进任务。
- 执行器可以替换：`src/chat/` 只认 `Executor` 接口和它的类型。

## 设计

### 总览

```
eos chat / 网页（PR B）
   │
   ▼
src/chat/chat.ts ── 每说一句：开 MCP 端点 → executor.send(builtinTools: 'none', mcp: [端点]) → 关端点、release
   │                                   │
   │                                   ▼
   │                      执行器（dsh）连 http://127.0.0.1:<随机端口>/mcp，带这次调用的令牌
   │                                   │
   ▼                                   ▼
src/chat/store.ts（chats、chat_messages、chat_trace）   src/chat/mcp.ts → src/chat/tools.ts（只读、截断、遮蔽）
```

### 能力面：用和执行器无关的字段表达

`src/executor/types.ts` 的 `AgentProfile` 加了两样：

| 字段 | 含义 |
|---|---|
| `builtinTools: 'standard' \| 'none'` | `none`：执行器自带的工具一个都没有，agent 只能用 `mcp` 里平台交给它的工具。任务里的角色用 `standard`，行为不变 |
| `mcp: AgentMcp[]` | 原来只有本地 stdio 服务（模板里写的）。现在也可以是 `HttpMcp`：平台提供的标准 MCP 端点（Streamable HTTP），带请求头 |

dsh 怎么做到这两样，只写在 `src/executor/dsh.ts`：

- `none` 关掉 sdk profile 里所有提供工具的插件行（`BUILTIN_TOOL_ROWS`：文件、搜索、命令行、技能、子 agent、提问、计划模式、交付物、Office、MCP 资源），以及会把本机文件内容带进会话的行（消息里的 @文件引用、工作区的 AGENTS.md）。
- `HttpMcp` 翻译成 dsh MCP 客户端的 `streamable-http` 配置。不重连：端点只活一次调用。
- 带 `HttpMcp` 的能力面，dsh 进程关掉时删掉它的配置目录。配置里有这次调用的令牌。

`scripts/chat-e2e.ts` 用真实的 dsh 核对：发给模型的工具表里只有 8 个 `mcp__eos__*` 工具。

### 只读工具

一张表（`src/chat/tools.ts` 的 `TOOLS`）列出全部工具：

| 工具 | 返回 |
|---|---|
| `list_conventions`、`get_convention`、`convention_history` | 工作流、约定文档、Agent 模板、技能的列表、内容、版本历史 |
| `list_tasks`、`get_task` | 任务列表；单个任务的状态、当前位置、失败原因、产出（截断）、记录摘要 |
| `get_task_trace` | 不给 call 时是每次调用的摘要；给 call 时是这次调用的事件（长内容截断） |
| `get_task_metrics` | 任务的阶段指标 |
| `get_task_changes` | 改动的文件列表和增删行数，不含文件内容和 diff |

- 没有写操作。没有读凭据表、读仓库文件内容的工具。`tests/chat.test.ts` 跑一遍每个工具，核对数据库一个字节都没变，不遮蔽时也拿不到凭据存储里的值。
- 参数在边界按 zod schema 解析。
- 返回先遮蔽再截断。先截断的话，截断处可能留下半截凭据，遮蔽认不出来。每个工具最多返回 20000 字。

### 平台的 MCP 端点

`src/chat/mcp.ts`。手写的最小实现，只支持 JSON 回复，不支持 SSE 流，不新增依赖。

- 每次调用开一个，调用结束就关。端口随机，令牌是 32 字节随机数。
- 同一台机器上的其他进程都连得到 127.0.0.1 的端口，例如别的任务的 agent、检查命令。所以令牌是唯一的防线：
  - 按定长比较：两边各算 sha256，再用 `timingSafeEqual`；
  - Host 必须是 `127.0.0.1:<端口>`，挡住 DNS rebinding；带 Origin 的请求一律拒绝，挡住浏览器。
- 只接受 `POST /mcp`。请求体最多 64 KiB，不接受批量请求。
- 一次调用最多 30 次工具调用，到上限后的调用都返回错误。

### 失败就关

agent 的 trace 里出现平台工具以外的工具名时，这一轮作废，记成「没有回复」。这种情况说明执行器没有按 `builtinTools: 'none'` 去掉自带工具。判断只看工具名的结尾，执行器给 MCP 工具加什么前缀都不影响。

### 对话的存储和续接

- 表在 `src/chat/store.ts` 里建，和任务共用一个 SQLite 文件，不改 `src/store/store.ts`。
  - `chats`：每个对话一行；
  - `chat_messages`：只追加，角色是 user / assistant / error。assistant 带用量、耗时，以及读了哪些数据（工具名和参数）；
  - `chat_trace`：事件流，已遮蔽。
- 执行器那一侧的会话按 key `chat/<对话 id>` 续接。第一句（或者之前每句都失败了）带上 `assistant` 模板的提示词，之后只发用户的话。
- 平台重启时，一句话的调用可能没做完。下一句之前先向执行器认领那次调用的回复（`findReply`），认领不到就记一条「没有回复」。
- 同一个对话同一时间只有一次调用（锁 `chat-<id>`），网页和命令行共用这把锁。
- 模型、effort、提示词来自内置 Agent 模板 `assistant`，团队可以改。权限由平台定死，改模板放不开。做法和 improver 一样，见 ADR-004。

### 换执行器时要做什么

新执行器实现 `Executor` 接口，并支持 `AgentProfile` 的这两个字段：

1. `builtinTools: 'none'`：不给 agent 任何自带工具；
2. `mcp` 里的 `HttpMcp`：让 agent 能用这个 MCP 端点的工具，带上 `headers`。

`src/chat/` 不用改。`tests/mcp-executor.ts` 是不调模型的假执行器，按标准 MCP 连端点。`tests/chat.test.ts` 用它跑通对话的主流程，证明 `src/chat/` 不依赖 dsh。

## 已知限制

- **令牌落在 dsh 的配置文件里。** dsh 的 MCP 配置只能写在 profile 补丁文件里（`<数据目录>/dsh/eos-profiles/<指纹>/cordis.patch.yml`，0644）。SDK 没有内联配置的入口。调用期间：
  - Docker 部署里，dsh home 属于 eos、组 eos-dsh、3770，检查命令的用户 eos-check 进不去，读不到（`docs/e2e/chat-a/docker-probe.json` 实测）。
  - dsh 和所有任务的 agent 共用 eos-agent。别的任务的 agent 能读到这个文件，在这次调用结束之前拿令牌连端点，读到遮蔽过的平台数据。这和路线图第 16 项「任务之间的隔离」是同一类问题。
  - 现状对比：任务的 agent 本来就能读整个 `/data`，包括所有任务的原始 trace。网页接口没有登录。所以这条路径没有让它们多读到什么。
  - 调用结束后配置目录删掉，端点关闭。
  - 不用 Docker 部署时，平台、dsh、检查命令是同一个用户，都读得到。
- **每说一句起一个 dsh 进程。** 令牌每次都换，配置的指纹也跟着变。每句话多 1–2 秒启动时间，会话从 dsh 的日志续接。
- **提示词注入。** 工具返回的 trace、任务产出里有其他 agent 写的文字。对话 agent 没有写工具，最坏是回答被带偏。PR C 加「提议」之后，提议只能由人确认才生效，那时再专门测。
- **没有登录。** 对话的 actor 只记 `cli` / `web`，和任务事件的写法一样。第 7 项登录做好之后换成具体的人。
- **改动摘要要读 git。** `get_task_changes` 在平台进程里对任务的 worktree 跑 git，和网页的改动列表一样，只返回文件列表。

## 没有采用的方案

- **新写一个直连模型 API 的执行器**：结构上没有文件工具，也没有令牌。但要自己做续接、重试、上下文压缩，约 400 行，和 dsh 分开维护。路线图第 18 项会引入第二个执行器，到时候它实现上面两个字段即可。
- **stdio 的 MCP 子进程直接读数据库**：子进程以 eos-agent 运行，读不到平台的数据库。它也拿不到主密钥，做不了遮蔽。
- **stdio 子进程中转到平台的 unix socket**：令牌同样要交给子进程，还多一层进程。

## 涉及的文件

- `src/executor/types.ts`（`builtinTools`、`HttpMcp`）、`src/executor/dsh.ts`（翻译）
- `src/chat/`：`types.ts`、`store.ts`、`tools.ts`、`mcp.ts`、`chat.ts`、`cli.ts`
- `src/workflow/agents/assistant.yaml`
- `tests/chat.test.ts`、`tests/mcp-executor.ts`、`tests/executor.test.ts`
- `scripts/chat-e2e.ts`、`scripts/chat-docker-probe.ts`
