# PoC：用 Claude Agent SDK 在服务端驱动 Claude Code

**这是一次性的验证代码，不是正式实现。** 它要回答的问题是：Eos 平台能不能用 Claude Agent SDK（TypeScript）驱动 Claude Code，并满足 `src/executor/types.ts` 里 `Executor` 接口需要的能力。路线图第 4 项。

- 验证对象：`@anthropic-ai/claude-agent-sdk@0.3.331`，它自带 Claude Code `2.1.331`（init 事件里的 `claude_code_version`）
- 运行环境：Node 22.23.5，Linux 容器，装了 bubblewrap 0.9.0 和 socat（`apt-get install -y bubblewrap socat`）。**两个都要**：只装 bubblewrap 时 Claude Code 的沙箱不可用，见第 3 项
- 真实模型：`claude-sonnet-5-5`（`common.ts` 的默认值），API key 认证
- 重跑方法：`./run-all.sh`（真实模型，需要 `EOS_ANTHROPIC_API_KEY`），或者 `EOS_MOCK=1 ./run-all.sh`（剧本模型，不需要凭据）。日志写到 `logs/real/`、`logs/mock/`。`logs/real-no-socat/` 是卸掉 socat 后单独跑第 3 项的日志。`run-all.sh` 有 FAIL 或者有脚本没跑完时退出码非 0

## 怎么验证的

所有脚本里，Claude Code 的 `ANTHROPIC_BASE_URL` 都指向宿主进程里的一个本机上游（`upstream.ts`），agent 进程里只有一个假 key：

- **真实模式**：上游把请求转发到 `api.anthropic.com`，转发时才换上平台持有的凭据。这本身就是第 8 项的方案。
- **mock 模式**：上游按剧本回复，强制 agent 按顺序发起指定的工具调用（例如往 worktree 外写文件）。这样验证的是 Claude Code 和平台侧的限制，不依赖模型配不配合；脚本也能直接核对真正发给模型的请求（系统提示、工具表、消息）。

两种模式跑的是同一套脚本，判定也一样。**mock 模式证明的是 Claude Code 这一侧的行为**：权限、工具表、会话记录、进程、环境。**真实模式补上与真实模型、真实 API 有关的部分**：模型会不会主动调用 AskUserQuestion，真实的用量和成本，订阅令牌能不能用。

## 结论

真实模型一列是 `claude-sonnet-5-5` 的结果：8 项全部通过，没有 FAIL。真实 45 条 PASS，mock 44 条：真实模式多跑一次 `c5-events-summarized`（+5）；第 3 项有 3 条、第 8 项有 1 条判定在真实模式下不记 PASS（−4），原因见下表。

| # | 验证项 | mock | 真实模型 | 证据 |
|---|---|---|---|---|
| 1 | 会话续接 | 通过 | 通过，和 mock 一致 | `logs/{mock,real}/c1-resume-*.log` |
| 2 | 主动提问 | 通过 | 通过，和 mock 一致（提示词要求它提问） | `logs/{mock,real}/c2-ask.log` |
| 3 | 权限限制 | 通过，`canUseTool` **不是每次都触发** | 通过；模型不调用工具表里没有的工具，A 的"没写成"和 C 的"强行调用报错"只有 mock 能证明 | `logs/{mock,real}/c3-perms.log` |
| 4 | 崩溃后找回 | 通过；宿主崩溃会留下孤儿进程 | 通过，和 mock 一致 | `logs/{mock,real}/c4-recover-*.log` |
| 5 | 事件流和用量 | 通过 | 通过；**思考默认只有签名、没有文字**，简单任务不思考 | `logs/{mock,real}/c5-events.log`、`logs/real/c5-events-summarized.log` |
| 6 | 技能、MCP、指令文件 | 通过 | 通过，和 mock 一致 | `logs/{mock,real}/c6-context.log` |
| 7 | 中止 | 通过 | 通过，和 mock 一致 | `logs/{mock,real}/c7-abort.log` |
| 8 | 环境隔离 | 通过：默认继承全部环境；key 不能交给 agent | 通过；"不传 `env`"一例在真实模式下不跑，只有 mock 证明 | `logs/{mock,real}/c8-env.log` |

### 真实模型和 mock 不一样的地方

| # | 哪里不一样 | 为什么 | 影响 |
|---|---|---|---|
| 3 A、C | 真实模型一次被去掉的工具都没有调用（`A 工具调用: []`、`强行调用: []`）；mock 里这些调用返回 `No such tool available` | 这些工具不在发给模型的工具表里，模型只是用文字说做不了。mock 的剧本不看工具表，硬发调用 | A 的"文件没写出来"、C 的两条"强行调用会报错"只有 mock 证明：真实模式下没有尝试，脚本记成 NOTE，不记 PASS。"init 工具表和发给模型的工具表里没有这些工具"两种模式都证明了 |
| 3 A2、B | 没有不一样：模型按提示词把越界操作全部试了一遍（A2 的 3 次、B 的 9 次调用和剧本逐条相同，A2 和 B 各有一次带 `dangerouslyDisableSandbox: true`），结果和 mock 相同 | 提示词写明是权限测试 | 只说明这个模型在被明确要求时会去试。没有验证它不被要求时会不会自己越界。这几条判定现在要求调用次数够数才算通过 |
| 5 | 提示词"先想一想，然后 echo hi"下真实模型没有思考（`thinking_tokens: 0`，没有 thinking 块），第一次真实运行这条判定 FAIL | 用的是自适应思考（`thinking: { type: 'adaptive' }`），模型自己决定要不要想 | 真实模式的提示词加了一道小推理题，之后每次都有思考。mock 的提示词没变 |
| 5 | 有思考时，默认拿到的 thinking 块 **文字是空的**（0 个字符），只有签名（1520 字符）；`thinking_delta` 只有 3 条。加上 `display: 'summarized'` 才有文字（318 个字符，35 条 `thinking_delta`） | SDK 的 `ThinkingAdaptive.display` 可选 `'summarized' \| 'omitted'`，这个模型默认不给文字 | 平台要在 trace 里展示思考，就得显式设 `display: 'summarized'`，拿到的是摘要。两种情况下 `thinking_tokens` 都有数（191、184），照常计费 |
| 5 | `assistant` 事件里每条消息自带的 `usage.output_tokens` 不是最终值：两条 API 消息在事件里是 5 和 19，合计 24，而 `result.usage.output_tokens` 是 502 | 事件里的 `usage` 取自流开始时的 `message_start` | 这一点 mock 下也成立（事件里是 1，`result` 里是 40），只是固定数字不显眼。实时事件里的用量不能拿来累加。`send` 用 `result.usage`；崩溃后从会话记录里算（第 4 项，记录里 nonce2 的 `output: 76`） |
| 7 | 中止后 SDK 调用结束的总耗时 9.9 秒，mock 是 5.6 秒 | 差的是真实模型发起两次工具调用之前的耗时（前台命令在第 4.7 秒才起来，mock 是 0.5 秒）。脚本在前台命令起来 3 秒后 abort，两种模式都在 abort 后约 2 秒返回 | 没有影响 |
| 8 | "不传 `env`"一例真实模式下不跑（记一条 NOTE） | 不传 `env` 时宿主的全部环境（包括真实 key 和容器里的其他凭据）都会进 agent 进程，不该交给真实模型驱动、没有沙箱的 agent。独立审查指出后改的 | 这一例验证的是 SDK 的行为，和模型无关：mock 日志里 `hasFake: true`、`hasRealKey: true`。改之前真实模式跑过这一例，当时的日志只记了变量名和布尔值，没有值 |

其余各项（1、2、4、6）的判定和证据形状都和 mock 相同，只有 id、端口、耗时这类每次都变的值不同。

### 1. 会话续接（`c1-resume.ts`）

能证明的：

- 会话 id 可以由平台指定：`sessionId` 传入由 key 算出的 UUID，两轮的 `session_id` 都等于它。
- 同一个 Claude Code 进程里多轮对话：`prompt` 传一个异步生成器（流式输入），第二轮答出了第一轮的暗号。
- 宿主进程 SIGKILL 自己之后，新进程用 `resume: <id>` 接回同一个会话，答出了暗号。mock 模式下的"答出"，是指之前的对话确实随请求发给了模型（剧本从请求历史里找暗号）。
- 会话记录写在 `$HOME/.claude/projects/<cwd 转成的目录名>/<id>.jsonl`。SDK 文档说可以用 `CLAUDE_CONFIG_DIR` 改位置；脚本里设的值和默认位置相同，没有验证改到别处。
- 对已经存在的 id 再用 `sessionId` 新建会报错 `Session ID ... is already in use`。所以平台第一次用 `sessionId`，之后一律用 `resume`。

### 2. 主动提问（`c2-ask.ts`）

能证明的：

- agent 调 `AskUserQuestion` 时，平台在 `canUseTool('AskUserQuestion', input)` 里拿到结构化的问题、`header`、选项和 `multiSelect`。
- 平台等了 5 秒（模拟用户回答），把回答写进 `updatedInput.answers`（问题文本 → 选项标签）后放行。agent 收到的工具结果是 `Your questions have been answered: "用哪种颜色？"="blue"`，接着按回答写出了 `color.txt = blue`。

证明不了的：

- 模型会不会在没人要求时自己调用 `AskUserQuestion`：提示词里明确要求了它先提问。真实模型照做了，问题、`header`、选项都是它自己写的（`请选择颜色：red 还是 blue？`）。
- 等几个小时再回答。SDK 文档写明权限回调"没有等待期限"，但等待期间 Claude Code 进程一直挂着这一轮。dsh 有 `continued` 状态，答案可以作为新的一轮到达；Claude Code 没有对应的东西。没有验证"先拒绝、中止，之后把答案当成下一轮发进去"这条路。

### 3. 权限限制（`c3-perms.ts`）

能证明的：

| 用例 | 配置 | 结果 |
|---|---|---|
| A 只读 | `tools: ['Read','Glob','Grep']` | 发给模型的工具表里没有 Write/Edit/Bash；强行调用返回 `No such tool available`；文件没有写出来 |
| A2 只读，但给 Bash | 加上 `sandbox: { enabled, failIfUnavailable, allowUnsandboxedCommands: false, filesystem: { denyWrite: [worktree] } }` | `cat` 能执行；`echo > worktree/x` 报 `Read-only file system`；带 `dangerouslyDisableSandbox: true` 也写不了 |
| B 可写 | `permissionMode: 'acceptEdits'`，沙箱默认（只能写 cwd），`canUseTool` 全部拒绝 | worktree 内的 Write 和 bash 写入成功，不经过回调；绝对路径、`../`、指向外面的软链接（回调里的 `blockedPath` 是解析后的真实路径）、bash 写外面、绕过沙箱的参数，**一个都没写成**。bash 写 `/tmp/...` 没有落到真实的 `/tmp` |
| C 去掉工具组 | `tools` 白名单，或者 `disallowedTools` 黑名单 | 两种方式都把工具从发给模型的工具表里去掉，强行调用都报错 |
| D 回调次数 | `permissionMode: 'default'`，加 `PreToolUse` hook | 6 次工具调用，`canUseTool` 只触发 2 次（`echo x > by-bash.txt` 的 Bash 和 Write，日志记了回调收到的命令）：两次 Read、Glob、`ls` 被自动放行，不经过回调。`PreToolUse` hook 6 次都触发，也能拒绝本来自动放行的 Read。平台拒绝的 Write 没有执行 |

**要注意的地方：**

- **不限制时的默认工具表**包括 `ListAgents`、`SendMessage`（跟同一台机器上的其他 Claude 会话通信，init 事件里有 `messaging_socket_path`）、`Workflow`、`CronCreate`、`ScheduleWakeup`、`EnterWorktree`、`Monitor` 等，见 `c3-perms.log` 的「C 不限制时」。新版本还可能加工具，所以**用 `tools` 白名单，不用黑名单**。
- `tools` 白名单**不会**隐藏 MCP 工具：在 `c6` 里，`tools: ['Read','Skill']` 时 `mcp__eos__get_codeword` 仍然在工具表里。MCP 工具要靠"不挂这个服务"，或者 hook 来限制。
- 逐次许可要用 `PreToolUse` hook，不要用 `canUseTool`。`canUseTool` 只负责"需要问人"的那部分调用，用来接主动提问正合适。

- **沙箱需要 bubblewrap 和 socat 两个**。只装 bubblewrap 时，开了沙箱（`failIfUnavailable: true`）的会话整轮直接报错，一次工具调用都不执行：`Sandbox required but unavailable: sandbox is enabled but dependencies are missing: socat not installed`（`logs/real-no-socat/c3-perms.log`：A2 和 B 两个用例共 4 条 FAIL，`attempts: 0`，都带这句报错）。这是安全的失败方式；部署文档和启动检查要把 socat 列进去，`run-all.sh` 已经加了检查。

证明不了的：

- 沙箱不可用时的"降级"（`failIfUnavailable: false`）：没有测，正式实现也不该用。
- 真实模型不被要求时会不会自己尝试越界：见上面「不一样的地方」。

### 4. 崩溃后找回（`c4-recover.ts`）

能证明的：

- 第 1 轮（nonce1）跑完，第 2 轮（nonce2）在 agent 执行 `./wait.sh` 时宿主 SIGKILL 自己。新进程不发消息，只用 `getSessionMessages(id, { dir: worktree })` 读本地会话记录：
  - nonce1：找到完整回复 `2`，最后一条 assistant 消息的 `stop_reason` 是 `end_turn`，用量也能算出来。
  - nonce2：最后一条是 `stop_reason: tool_use`，判成"没做完，需要重发"。
- 判定方法跟 dsh 一样：从带 nonce 的用户消息开始，到下一条带 nonce 的用户消息为止，要求最后一条 assistant 消息已经结束。
- 会话记录里一条 API 消息会按内容块拆成几条，它们共用同一个 `message.id` 和同一份 `usage`。**用量要按 `message.id` 去重**。
- 平台自己的 `SessionStore`（alpha 接口）能拿到会话记录的镜像，按 nonce1 也能找回。但它要求宿主和 agent 进程的 `CLAUDE_CONFIG_DIR` 一致，否则镜像帧会被丢掉（SDK 源码里有这句警告；这里没有留下不一致时的日志）。而且崩溃时镜像落后于本地文件：本地 5 条，镜像 2 条。所以**找回以本地文件为准**。

**要注意的地方：**

- **宿主进程崩溃后，Claude Code 子进程不会退出**：ppid 变成 1，35 秒后仍然在运行（日志里 `ps` 的第二列）。这次它停在工具调用上：上游在宿主进程里，宿主一死它就连不上模型。正式实现里上游如果独立存活，孤儿进程可能自己把这一轮跑完，这种情况没有覆盖。平台启动时要自己清理这些进程，可以按命令行里的 `--session-id=<id>` 找，或者按进程组找。
- Claude Code 会拦下前台的 `sleep N`（工具结果提示改用 Monitor）。这不影响平台，但测试脚本要换一种写法来等待。

### 5. 事件流和用量（`c5-events.ts`）

能证明的：

- 能拿到的消息：`system/init`、`system/status`、`system/thinking_tokens`、`assistant`（内容块 `thinking` / `text` / `tool_use`）、`user`（`tool_result`）、`result/success`。打开 `includePartialMessages` 后还有 `stream_event`，包括 `text_delta`、`thinking_delta`、`signature_delta`、`input_json_delta`。
- `result.usage` 里缓存读（`cache_read_input_tokens`）和缓存写（`cache_creation_input_tokens`，还拆成 5 分钟和 1 小时两种）是分开的，另外有 `output_tokens_details.thinking_tokens`。
- `result.modelUsage` 按模型给出用量和 `costUSD`，另外有 `total_cost_usd`、`duration_ms`、`duration_api_ms`、`num_turns`。成本按官方价目表算（`costBasis: "list"`）。

真实模型下（`logs/real/c5-events.log`，一轮两次 API 调用）：

- 用量：`input_tokens: 4`、`cache_read_input_tokens: 4219`、`cache_creation_input_tokens: 1247`（全是 5 分钟档）、`output_tokens: 502`，其中 `thinking_tokens: 191`。输入几乎全走缓存。
- 成本 `total_cost_usd: 0.0086`，`modelUsage` 的键是 `claude-sonnet-5-5`，`costBasis: "list"`；`duration_ms: 5501`，`duration_api_ms: 5388`。
- 思考默认没有文字，实时事件里的 `usage` 不是最终值：见「真实模型和 mock 不一样的地方」。

证明不了的：成本数字对不对（没有和账单核对）；完整的思考原文（`display` 只有 `summarized` 和 `omitted` 两个值）。

### 6. 技能、MCP、指令文件（`c6-context.ts`）

能证明的：

- **技能按会话指定**：把平台给这个角色的技能放进一个本地插件目录（在平台数据目录里，不在 worktree 里），用 `plugins: [{ type: 'local', path }]` 挂上，再用 `skills: ['eos:codeword']` 列出允许的技能。agent 用 Skill 工具调用后，技能内容进了上下文。发给模型的技能列表里没有 Claude Code 自带的技能（claude-api、update-config 等）；调用没给的技能会被拒绝（`not in this session's skills allowlist`）。init 事件的 `skills` 字段仍然列出自带技能，不能拿它当依据。
- **MCP 按会话指定**：`mcpServers: { eos: { type: 'stdio', command, args, env } }`，init 里显示 `connected`，工具调用拿到了服务返回的暗号。
- **指令文件**：不传 `settingSources`（默认）时，请求里出现了 worktree 的 `CLAUDE.md`、`$HOME/.claude/CLAUDE.md` 和 worktree 里 `.claude/skills/` 的技能；设成 `settingSources: []` 后一个都没有。worktree 的 `AGENTS.md` 两种情况下都没有出现。默认时还会读 worktree **上级目录**的 `CLAUDE.md`：真实模型的回复里提到了本仓库根目录的 `CLAUDE.md`（`logs/real/c6-context.log`）。脚本往 worktree 的 `.claude/settings.json` 里也写了内容，但没有检查它是否生效。

### 7. 中止（`c7-abort.ts`）

能证明的：

- agent 起了一个后台命令（`run_in_background: true`）和一个前台命令，三者都在运行（abort 前用 `pgrep` 核对过）。平台调用 `abortController.abort()` 后，SDK 大约 2 秒内抛出 `Claude Code process aborted by user`。3 秒后 Claude Code 进程、前台命令、后台命令都不在了；两个命令各自起的 `sleep`（孙进程，abort 前按父进程记下 pid）也都不在了。

这和第 4 项不一样：**平台主动中止时进程树会被清干净，平台自己崩溃时不会**。

### 8. 环境隔离（`c8-env.ts`）

能证明的：

- **不传 `env` 时，SDK 让 Claude Code 继承宿主进程的全部环境**：mock 模式下本容器里 Claude Code 进程有 134 个变量，其中有 `AWS_SECRET_ACCESS_KEY` 这样的名字。宿主里的假凭据 `EOS_FAKE_SECRET` 被 agent 的 Bash 读到了。宿主直接读 `/proc/<pid>/environ` 确认**平台的真实 key（`EOS_ANTHROPIC_API_KEY`）也在里面**（`logs/mock/c8-env.log` 的 `hasRealKey: true`；日志只记布尔值）。这一例只在 mock 模式下跑。
- 显式传 `env` 时，Claude Code 进程只有 10 个变量（宿主直接读 `/proc/<pid>/environ` 核对，日志里有名字）：平台给的 6 个，加上 SDK 自己加的 4 个（`BUN_ENABLE_CRASH_REPORTING`、`CLAUDE_AGENT_SDK_VERSION`、`CLAUDE_CODE_ENTRYPOINT`、`CLAUDE_CODE_SDK_READS_SESSION_STATE`），宿主的假凭据和真实 key 都不在里面（`hasRealKey: false`），agent 能读到的 key 只有占位的 `sk-ant-eos-placeholder`。真实模式的 8 项都是这样跑通的：真实 key 只在宿主的上游里使用。agent 的 Bash 里还会多出 Claude Code 自己加的变量（`CLAUDE_CODE_SESSION_ID`、`CLAUDE_CODE_MESSAGING_SOCKET`、`CLAUDE_CODE_MESSAGING_TOKEN` 等），以及登录 shell 读取的 profile。
- **交给 Claude Code 的模型 key，agent 能读到**：把 key 直接放进 `env`，agent 的 Bash 能从自己的环境和 `/proc/$PPID/environ`（Claude Code 进程）里读出来。所以凭据不能这样给。平台要像 `upstream.ts` 这样做：在本机起一个上游，Claude Code 只拿到上游地址和一个假 key，转发时才换上真凭据。

证明不了的：

- agent 能不能直接连这个本机上游，借平台的凭据调用模型。它能连到 127.0.0.1，只是拿不到凭据本身。正式实现时，上游要只接受带一次性令牌的请求（例如按会话发一个假 key，只认这个 key），或者用沙箱的网络限制挡住。这次没有验证。
- 沙箱的 `credentials.envVars`（屏蔽环境变量）没有测。

## 按 Executor 接口接入需要做什么

| 接口 | 怎么实现 |
|---|---|
| `send` | 每次调用一个 `query()`：第一次用 `sessionId`（由 key 算出的 UUID），之后用 `resume`。`cwd` 是 worktree；`env` 显式给出，只放上游地址和假 key；`settingSources: []`；`model`、`effort`；`abortController`；提示词末尾带 nonce 标记。回复取 `result.result`，用量取 `result.usage`，耗时取 `duration_ms`，模型取 `modelUsage` 的键 |
| 能力面 `AgentProfile` | `denyTools` 换算成 `tools` 白名单（下表）；`skills` 写进平台数据目录里的一个插件，再用 `skills` 列出名字；`mcp` 换成 `mcpServers`；`background: false` 时由 `PreToolUse` hook 拒绝带 `run_in_background` 的 Bash（推断：hook 能拒绝已经验证过，按参数拒绝没有单独测） |
| `WriteScope` | `none`：不给 Write/Edit/NotebookEdit；要给 Bash 的话开沙箱，并且 `denyWrite: [worktree]`。`worktree`：`acceptEdits`，开沙箱，`allowUnsandboxedCommands: false`，worktree 外的写入交给 `canUseTool` 拒绝。`writePaths` 照旧由平台在事后撤销越界改动 |
| `ask` | `canUseTool` 里只处理 `AskUserQuestion`：转成 `AgentQuestion`，等 `AskHandler` 返回后写进 `updatedInput.answers`；其他需要许可的调用按策略拒绝 |
| `onEvent` | `assistant` 的内容块和 `user` 的 `tool_result` 转成 `TraceEvent`。要展示思考就设 `thinking.display: 'summarized'`；事件里的 `usage` 不是最终值，不要累加。逐次的平台检查放在 `PreToolUse` / `PostToolUse` hook 里 |
| `findReply` / `traceOf` | 读 `CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`（或者 `getSessionMessages`），按 nonce 切出范围，最后一条 assistant 是 `end_turn` 才算完成；用量按 `message.id` 去重。会话记录是普通 jsonl，不用像 dsh 那样逐帧解 zstd |
| `release` / `close` | 每次调用结束后，`query()` 的进程就退出了。平台启动时还要清理崩溃留下的 Claude Code 进程（按 `--session-id=`） |
| 凭据 | 平台起一个本机上游，转发到 Anthropic 时加上凭据；agent 进程里只有假 key |
| `CLAUDE_CONFIG_DIR` | 每个任务一个，放在平台数据目录下（会话记录、shell 快照都在这里）。SDK 类型注释说本地记录会按 `cleanupPeriodDays` 清理（没有实测），保留期要设得足够长 |

工具组（`ToolGroup`）到 Claude Code 工具名：工具名来自 c3 的默认工具表，归到哪一组是按名字推断的（`TaskStop` 停后台任务和子 agent，两组都放）。白名单的意思是：不在这个组里的工具才放进 `tools`。

| 组 | Claude Code 工具 |
|---|---|
| web | `WebFetch`、`WebSearch` |
| subagent | `Agent`（init 里叫 `Task`）、`Workflow`、`ListAgents`、`SendMessage`、`TaskStop` |
| bash | `Bash`、`Monitor`、`TaskStop` |
| schedule | `CronCreate`、`CronDelete`、`CronList`、`ScheduleWakeup` |
| todo | 这个版本的默认工具表里没有 TodoWrite |
| goal | 没有对应的工具（`/goal` 是斜杠命令） |

不管什么角色都不该给的：`ListAgents`、`SendMessage`（跨会话）、`EnterWorktree` / `ExitWorktree`（会换工作目录）、`EnterPlanMode` / `ExitPlanMode`、`ToolSearch`。

## 和 dsh 不一样的地方

| | dsh | Claude Code |
|---|---|---|
| 能力面 | 按进程配置（profile 补丁），按指纹分进程 | 按会话配置（`query()` 的选项），不用分进程 |
| 写入范围 | dsh 的权限档位 + 沙箱 | Write/Edit 走权限规则（cwd 内自动放行，cwd 外转给回调）；Bash 走 Claude Code 自己的 bwrap 沙箱 |
| 逐次许可 | 审批回调 | `canUseTool` 不是每次都触发，要用 `PreToolUse` hook |
| 提问 | `ask_user_question` 有 `open` / `continued` 状态，可以长时间挂起 | `AskUserQuestion` 走权限回调，等待期间进程一直挂着 |
| 会话记录 | zstd 多帧的 `session.v4.jsonl.zstd` | 普通 jsonl；另有 `SessionStore` 镜像（alpha） |
| 凭据 | 代理注入，dsh 进程里有 provider key | 必须由平台的上游注入；交给 Claude Code 的 key，agent 能读到 |
| 指令文件 | 不读仓库的 CLAUDE.md | 默认会读，要设 `settingSources: []` |
| 崩溃 | — | 宿主崩溃后 Claude Code 进程不会退出，要自己清理 |

## 做不到或者还没找到办法的

1. **长时间挂起的提问**：没有和 dsh `continued` 对应的机制，用户迟迟不回答时只能让进程一直挂着。可以试的办法：拒绝这次提问并中止这一轮，等用户回答后把答案作为下一轮发进去。没有验证。
2. `tools` 白名单管不到 MCP 工具，要另外限制。

## 还没证明的

| 内容 | 原因 |
|---|---|
| 订阅令牌（`EOS_AUTH=oauth`）能不能经平台的上游使用 | 这次运行的环境里没有 `EOS_CLAUDE_OAUTH_TOKEN`（只有 `EOS_ANTHROPIC_API_KEY`），`run-all.sh` 跳过了 `c1-oauth-*`。设上令牌重跑即可 |
| 其他模型（Opus、Haiku 等）下的结果 | 只跑了 `claude-sonnet-5-5`。可以用 `EOS_MODEL` 换 |
| 真实模型不被要求时的行为：会不会自己调用 AskUserQuestion，会不会自己尝试越界 | 提示词都明确要求了这些操作 |
| "强行调用被去掉的工具会报错"在真实模型下 | 真实模型不调用工具表里没有的工具，只有 mock 能发起这种调用 |
| 结果稳不稳定 | 真实模式完整跑了 4 遍（后两遍 0 FAIL；前两遍的 FAIL 是缺 socat 和提示词没让模型思考），仓库里只留最后一遍的日志，前几遍的结果无法从仓库复核。没有做更多次重复 |
| 成本数字和账单是否一致 | 没有核对账单 |
| 沙箱不可用时的降级（`failIfUnavailable: false`） | 没有测 |
| agent 或本机其他进程能不能借本机上游调用模型 | 这个 PoC 的上游不做认证，本机任何进程都能连。平台部署在共用服务器上，正式实现必须加认证，见第 8 项 |
| Claude Code 自己写在 `/tmp` 的东西对共用服务器的影响 | 日志里能看到它在 `/tmp` 下建了 `cc-socks/<pid>.sock`（跨会话消息）和 `claude-*-cwd` 文件，没有研究能不能改位置、权限是什么 |
| 工具表里的 `DeferredToolPlaceholder` 是什么 | 每个请求的工具表里都有，推测和延迟加载工具（`ToolSearch`）有关，没有查证 |
| 并发多个会话时的资源占用、冷启动耗时 | 本次只跑了单个会话 |
