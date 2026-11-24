# Eos Workbench

> Eos（厄俄斯）是希腊神话里的黎明女神，每天清晨推开天门，唤醒新的一天。

Eos 是一个可以自部署的多 agent 工作流平台。你在 Web 上发起一个开发任务，Eos 按工作流把它交给多个职责不同的 agent：规划、开发、评审、测试。和"打回重跑"不同，开发和评审、测试会在同一个会话里来回对话，直到通过；连续 5 轮不通过时，会请上游 agent 重新确认做法和需求；遇到卡点，agent 会主动问你。

执行内核是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，默认模型 DeepSeek-V4.1-Flash（`deepseek-flash`）。

> **状态：重写中。** Eos 原先是一个 Claude Code mod，现在正在改造成独立平台，设计见 [ADR-001](docs/adr/001-self-hosted-multi-agent-platform.md)。旧版本的代码在 git 历史里（`84403d7` 及之前）。

## 里程碑

| 里程碑 | 内容 |
|---|---|
| M1 | 工作流引擎、dsh 执行器、SQLite 存储、命令行：跑通"规划 → 开发 → 评审对话" |
| M2 | Web 界面、对话式生成工作流、主动提问的"待我回答"列表 |
| M3 | 测试对话、GitHub 仓库接入（克隆、推分支、开 PR）、工具白名单与 skills |
| M4 | 外部执行器：Claude Code、Codex |
| M5 | Docker Compose 部署（含 bubblewrap）与端到端验收 |

## 试用

需要 Node ≥ 24.9、git，以及环境变量 `DEEPSEEK_API_KEY`。

```bash
npm install && npm run build:web
```

```bash
npm run eos -- web
```

打开 http://127.0.0.1:4317 ：

- **新建任务**：填本机 git 仓库的路径、选工作流、写需求。任务在服务里运行，每个任务有自己的分支 `eos/<任务id>` 和 worktree，不会改动你当前的工作目录。
- **任务页**：trace 树里能看到每一次模型请求和工具调用，以及参数、结果、思考过程、耗时和 token；agent 提问时在页面上点选项或输入回答；任务可以继续、重试、中止。运行中每 2 秒刷新。
- 服务重启后，没跑完的任务会自动接着跑，已完成的调用不会重发。

部署到团队共用的服务器：用 Docker Compose，见 [`docs/deploy.md`](docs/deploy.md)。

命令行也能用，和页面共用同一份数据和任务锁，同一个任务不会被两边同时跑：

```bash
npm run eos -- run --repo <仓库路径> "<需求>"
```

其他命令：`resume`、`retry`、`answer`、`status`、`log`、`abort`、`workflows`，见 `npm run eos -- --help`。数据默认在 `~/.eos`。

> 安全：Web 服务默认只监听 `127.0.0.1`，没有登录，只接受本机 Host 和同源请求。它能在本机任何 git 仓库上建分支和 worktree，只适合在自己的机器上单人使用。
>
> 在容器或反向代理后面运行时：`--host 0.0.0.0` 改监听地址；浏览器用别的地址访问时设 `EOS_PUBLIC_URL`（例如 `https://eos.example.com`），平台只额外接受这个地址的 Host 和 Origin，反向代理要把原始 Host 传过来。没有登录：能打开这个地址的人都能建任务、看 trace，不要直接暴露到公网。

## 开发

需要 Node ≥ 24.9。

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

PoC 与验证结论见 [`poc/README.md`](poc/README.md)。
