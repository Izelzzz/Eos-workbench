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
