# devbench：Claude Code 里的个人 AI 开发工作台

devbench 是一个 Claude Code mod（插件），它在 Claude Code 里搭起一条价值流式的开发流水线：

```
需求 Spec ──⏸批准──▶ 代码开发 ──▶ 单元测试 ──▶ Code Review ──⏸批准──▶ 合并 ──⏸批准──▶ 发布部署
                       ▲              │              │
                       └── 返工（带着测试输出 / 评审意见，最多 N 次）──┘
```

聊天旁边常驻一个面板，显示每个阶段的状态、耗时、token、返工次数和产物，以及整条流水线的价值流指标（Lead Time、执行时间、等待时间、流动效率、一次通过率）。

## 设计原则

| 原则 | 做法 |
|---|---|
| 阶段之间只靠产物交接 | 每个阶段是一个独立的子 agent，看不到其他阶段的对话；输入输出都是 `.devbench/tasks/<id>/artifacts/` 下的文件 |
| 不让模型自己验收自己 | 评审者是全新上下文的子 agent，只读 Spec 和 diff，默认用和开发不同的模型（sonnet）；测试阶段只看测试命令的退出码 |
| 不可逆操作必须人工批准 | 合并、部署前强制停下等待批准；任务进行中，模型执行 `git push/merge/rebase`、`npm publish`、`wrangler deploy` 等命令会被 hook 直接拒绝 |
| 数据不锁在 mod 里 | 任务记录是普通 JSON 文件（`task.json`），以后可以直接做 Web 看板读取 |
| 核心逻辑与引擎解耦 | 状态机、指标、评审结论解析都是纯函数（`hooks/core/`），不依赖 Claude Code API，可单测 |

## 安装

在终端 Claude Code 的输入框里：

```
/plugin install devbench --marketplace Izelzzz/agents-pipeline
```

或在 shell 里：

```bash
claude plugin install devbench --marketplace Izelzzz/agents-pipeline
```

仓库是私有的话，本机需要已有 github.com 的 git 凭证（例如先 `gh auth login` 再 `gh auth setup-git`）。

开发时也可以直接从本地目录加载：

```bash
claude --plugin-dir /path/to/agents-pipeline
```

## 使用

在一个 git 仓库里打开 Claude Code：

| 命令 | 作用 |
|---|---|
| `/devbench new <需求>` | 创建任务：新建分支 `devbench/<id>` 和独立 worktree，开始写 Spec |
| `/devbench approve` | 批准当前等待的阶段（也可以在面板上点按钮，或按 `a`） |
| `/devbench reject <理由>` | 驳回，必须写理由：Spec 阶段会带着理由重写；合并前驳回会回到 Code Review，评审者逐条核实理由，成立才打回开发（不计返工次数）；部署前驳回则跳过部署。面板上按 `r` 会把 `/devbench reject ` 填进输入框，补上理由后回车 |
| `/devbench retry` | 重试当前阶段（例如会话重启后子 agent 已经不在了） |
| `/devbench skip <理由>` | 跳过当前等待中或失败的阶段（测试 / 评审 / 合并 / 部署），用于已在流水线之外完成的情况，例如已手动合并；也可在面板上按 `s` |
| `/devbench abort` | 中止任务，并停止当前阶段正在运行的子 agent 或命令（测试、合并、部署、依赖安装）；对运行中的阶段 `retry` 时也会先停掉旧的那次，旧的结果不会记到新的这次上 |
| `/devbench list` | 列出所有任务 |
| `/devbench select <id>` | 面板切换到某个任务 |
| `/devbench` | 打开面板 |

## 配置（可选）

在项目根目录放 `.devbench.json`：

```json
{
  "testCommand": ["npm", "test"],
  "setupCommand": ["npm", "ci"],
  "deployCommand": ["npx", "wrangler", "deploy"],
  "maxRework": 2,
  "models": { "planner": "inherit", "developer": "inherit", "reviewer": "sonnet" },
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
| `protectedCommands` | 在内置规则之外再拦截的命令（正则字符串） |

命令都是 argv 数组，不经过 shell。

## 产物与数据

```
<repo>/.devbench/            # 自动写入 .gitignore，不会进仓库
  tasks/<id>/task.json       # 任务与各阶段记录（状态、耗时、token、模型、返工）
  tasks/<id>/artifacts/
    01-spec.md
    02-setup.log
    02-dev-notes-<n>.md
    02-diff.patch
    03-test-<n>.log
    04-review-<n>.json
    05-merge.log
    06-deploy.log
  worktrees/<id>/            # 任务的独立 git worktree
```

## 已知限制（MVP）

- 流水线跑在 Claude Code 会话里：关掉会话，正在跑的子 agent 也会停。重新打开后用 `/devbench retry` 继续。
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
