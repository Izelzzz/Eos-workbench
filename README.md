# Eos Workbench：Claude Code 里的个人 AI 开发工作台

> Eos（厄俄斯）是希腊神话里的黎明女神。每天清晨，她推开天门，让光照进世界，唤醒新的一天。
>
> 这个工作台借用她的名字：你在 Claude Code 里输入 `/eos`，就像拉开晨幕，唤醒一条开发流水线。之后需求、开发、测试、评审、合并、部署，一个阶段接一个阶段被依次点亮，每一段走过的时间、花掉的 token、留下的产物都被记录下来。

Eos 是一个 Claude Code mod（插件），它在 Claude Code 里搭起一条价值流式的开发流水线：

```
需求 Spec ──⏸批准──▶ 代码开发 ──▶ 单元测试 ──▶ Code Review ──⏸批准──▶ 合并 ──⏸批准──▶ 发布部署
                       ▲              │              │
                       └── 返工（带着测试输出 / 评审意见，最多 N 次）──┘
```

聊天旁边常驻一个面板，显示每个阶段的状态、耗时、token、返工次数和产物，以及整条流水线的价值流指标（Lead Time、执行时间、等待时间、流动效率、一次通过率）。

## 设计原则

| 原则 | 做法 |
|---|---|
| 阶段之间只靠产物交接 | 每个阶段是一个独立的子 agent，看不到其他阶段的对话；输入输出都是 `.eos/tasks/<id>/artifacts/` 下的文件 |
| 不让模型自己验收自己 | 评审者是全新上下文的子 agent，只读 Spec 和 diff，默认用和开发不同的模型（sonnet）；测试阶段只看测试命令的退出码 |
| 不可逆操作必须人工批准 | 合并、部署前强制停下等待批准；任务进行中，模型执行 `git push/merge/rebase`、`npm publish`、`wrangler deploy` 等命令会被 hook 直接拒绝 |
| 数据不锁在 mod 里 | 任务记录是普通 JSON 文件（`task.json`），以后可以直接做 Web 看板读取 |
| 核心逻辑与引擎解耦 | 状态机、指标、评审结论解析都是纯函数（`hooks/core/`），不依赖 Claude Code API，可单测 |

## 安装

在终端 Claude Code 的输入框里，先添加 marketplace，再安装：

```
/plugin marketplace add Izelzzz/Eos-workbench
```

```
/plugin install eos@eos-workbench
```

或在 shell 里：

```bash
claude plugin marketplace add Izelzzz/Eos-workbench
```

```bash
claude plugin install eos@eos-workbench
```

从旧名字 devbench 升级：先卸载旧插件（`/plugin uninstall devbench@agents-pipeline`），再按上面安装。之前在 `.devbench/` 里的任务和 `.devbench.json` 配置仍会被读取，新任务写到 `.eos/`。

开发时也可以直接从本地目录加载：

```bash
claude --plugin-dir /path/to/Eos-workbench
```

## 使用

在一个 git 仓库里打开 Claude Code：

| 命令 | 作用 |
|---|---|
| `/eos new <需求>` | 创建任务：新建分支 `eos/<id>` 和独立 worktree，开始写 Spec |
| `/eos approve` | 批准当前等待的阶段（也可以在面板上点按钮，或按 `a`） |
| `/eos reject <理由>` | 驳回，必须写理由：Spec 阶段会带着理由重写；合并前驳回会回到 Code Review，评审者逐条核实理由，成立才打回开发（不计返工次数）；部署前驳回则跳过部署。面板上按 `r` 会把 `/eos reject ` 填进输入框，补上理由后回车 |
| `/eos retry` | 重试当前阶段（例如会话重启后子 agent 已经不在了） |
| `/eos skip <理由>` | 跳过当前等待中或失败的阶段（测试 / 评审 / 合并 / 部署），用于已在流水线之外完成的情况，例如已手动合并；也可在面板上按 `s` |
| `/eos abort` | 中止任务，并停止当前阶段正在运行的子 agent 或命令（测试、合并、部署、依赖安装）；对运行中的阶段 `retry` 时也会先停掉旧的那次，旧的结果不会记到新的这次上 |
| `/eos list` | 列出所有任务 |
| `/eos log [id]` | 任务的完整时间线：每次批准、驳回、重试、跳过、子 agent 启动与每次运行的结果和用量，最后是各阶段汇总；面板上的「时间线」按钮（`l`）会把这条命令填进输入框 |
| `/eos select <id>` | 面板切换到某个任务 |
| `/eos` | 打开面板 |

## 配置（可选）

在项目根目录放 `.eos.json`：

```json
{
  "testCommand": ["npm", "test"],
  "setupCommand": ["npm", "ci"],
  "deployCommand": ["npx", "wrangler", "deploy"],
  "maxRework": 2,
  "models": { "planner": "inherit", "developer": "inherit", "reviewer": "sonnet" },
  "stages": {
    "dev": { "model": "opus", "effort": "high", "skills": ["pstack:poteto-mode"] },
    "review": { "skills": ["engineering:code-review"] }
  },
  "protectedCommands": ["^make release"]
}
```

| 字段 | 默认值 |
|---|---|
| `testCommand` | `package.json` 里有 `test` 脚本时用 `npm test`，否则跳过测试阶段（面板会提示） |
| `setupCommand` | 根据锁文件选 `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile`；没有 `package.json` 则不执行。在新 worktree 里第一次开发前运行 |
| `deployCommand` | 不配置则跳过部署阶段 |
| `maxRework` | 2 |
| `models` | 评审默认用 `sonnet`，其余继承当前会话模型 |
| `stages` | 按阶段（`spec` / `dev` / `review`）配置子 agent：`model` 优先于 `models` 里对应角色的设置；`effort` 是 `low`…`max` 或整数预算；`skills` 是 skill 名（`插件:skill`，或项目 / 用户 `.claude/skills` 下的名字）。每次启动该阶段的子 agent 前按当时的配置重新注册，改了不用重启会话 |
| `protectedCommands` | 在内置规则之外再拦截的命令（正则字符串） |

命令都是 argv 数组，不经过 shell。

关于 `skills`：Claude Code 不会把 frontmatter 写了 `disable-model-invocation: true` 的 skill 预加载进子 agent（pstack 的 skill 几乎都是这样；实测 `pstack:poteto-mode` 预加载后子 agent 上下文里没有它，`engineering:code-review` 和 `pstack:setup-pstack` 则有）。Eos 会找到这类 skill 的 `SKILL.md`（插件 skill 按 `~/.claude/plugins/installed_plugins.json` 里的安装目录找），在任务提示词最前面加一行「先完整阅读并遵循 <绝对路径>」；找不到文件的 skill 照常预加载。

## 产物与数据

```
<repo>/.eos/            # 自动写入 .gitignore，不会进仓库
  tasks/<id>/task.json       # 任务与各阶段记录（状态、耗时、token、模型、返工、每次运行的明细）
  tasks/<id>/events.jsonl    # 审计记录：每个事件一行，只追加
  tasks/<id>/artifacts/
    01-spec.md               # 最新版（提示词引用它）
    01-spec-<seq>.md         # 每次运行各存一份
    02-setup.log
    02-dev-notes-<n>.md
    02-diff.patch
    02-diff-<seq>.patch
    03-test-<n>.log
    04-review-<n>.json
    05-merge.log
    05-merge-<seq>.log
    06-deploy.log
    06-deploy-<seq>.log
  worktrees/<id>/            # 任务的独立 git worktree
```

### 每次运行的明细（`task.json` 里 `stages.<阶段>.runs`）

每次开始运行追加一条，按 `seq` 一一对应：

| 字段 | 含义 |
|---|---|
| `seq` / `attempt` | 运行编号（只增不减）；开始时的 `attempts` |
| `cause` | `initial` 第一次；`rework` 返工回来（含返工后重新经过的测试和评审）；`reject` 被驳回后重跑；`retry` 人工重试 |
| `startedAt` / `endedAt` / `durationMs` / `tokens` | 这次运行的时间与用量 |
| `model` / `effort` / `skills` / `agentId` | 子 agent 阶段启动时用的配置 |
| `outcome` | `running` / `passed` / `failed` / `abandoned`（中止或重试时被放弃，子 agent 或命令已停掉） |
| `note` | 失败原因，或放弃的原因 |
| `artifacts` | 这次运行写下的产物（会被覆盖的那几个记带 `seq` 的副本名） |

阶段上原有的累计值（`durationMs`、`tokens`、`attempts` 等）和面板上的数字保持原来的含义：`durationMs` 与 `tokens` 等于未被放弃的那些运行之和。被放弃的运行在被停掉之前已经花掉的时间和 token（包括它迟到的回报）只记在它自己的记录上，`/eos log` 的汇总里单独列出。

旧版本创建的任务载入时 `runs` 为空数组，之前的运行只剩累计值，时间线会注明。

### 审计记录（`events.jsonl`）

每次交给状态机的事件（命令、面板按钮、子 agent 的回报、测试 / 合并 / 部署命令的结果、Eos 自己的处理）都追加一行 JSON，另外任务创建和每次子 agent 启动也各记一行。文件只在末尾追加，已有的行不会被改写。

| 字段 | 含义 |
|---|---|
| `ts` | 时间（ms） |
| `taskId` / `stage` | 任务与事件涉及的阶段 |
| `actor` | `command`（`/eos` 命令）、`panel`（面板按钮）、`agent`（子 agent）、`process`（命令阶段的进程）、`system`（Eos 自己，例如子 agent 启动或启动失败） |
| `event` | 事件本身，含驳回 / 跳过的理由、结果的说明与用量 |
| `before` / `after` | 事件前后的任务状态、当前阶段，以及该阶段的状态和 `seq` |
| `action` | 状态机给出的下一步 |
| `accepted` | `false` 表示任务没有变化，例如没写理由的驳回、过期的运行结果 |

## 已知限制（MVP）

- 流水线跑在 Claude Code 会话里：关掉会话，正在跑的子 agent 也会停。重新打开后用 `/eos retry` 继续。
- 子 agent 和主会话共用一份额度。Pro 订阅跑一个完整任务会消耗不少用量。
- 合并完成后不会自动清理 worktree 和分支。
- mod API 目前是早期版本，后续 Claude Code 升级可能需要跟着调整。

后续计划见仓库的 Issues。

## 开发

```bash
claude plugin validate .
claude plugin test .
```

类型检查用插件 API 的声明文件（Claude Code 加载 mod 时会写到 `.claude-plugin/types/`），然后运行 `tsc -p .`。
