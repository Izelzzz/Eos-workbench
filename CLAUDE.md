# 本仓库的工作约定

Eos 是一个自部署的多 agent 工作流平台，以 DeepSeek Harness（dsh）为执行内核。设计见 `docs/adr/001-self-hosted-multi-agent-platform.md`。

## 写代码用 poteto mode

项目设置启用了 pstack 插件（`.claude/settings.json`）。

- 写代码的任务（功能、修 bug、重构、评审修复）按 poteto mode 执行：先读 `pstack:poteto-mode` 的 `SKILL.md` 和它附带的 `docs/harness/claude-code.md`，按映射把 Cursor 的名字换成 Claude Code 的。
- 按 SKILL.md 匹配 playbook，把步骤原样列成待办再开始。
- 需要 Cursor 专属能力的步骤按 harness 文档跳过，并在回复里写一行 `Skipped in Claude Code: <步骤>. <原因>.`。
- **写代码只用主 agent。** 所有"交给子 agent 实现"的步骤由主 agent 自己完成；需要多个子 agent 并行的 skill（`arena`、`swarm`、`interrogate` 等）不用，或只按其思路在主 agent 内做，并写一行 `Skipped: <步骤>. 只用主 agent。`。
- **唯一的例外：合并前的独立审查。** 每个 PR 合并前，派一个全新的子 agent（看不到写代码的对话）做两件事：独立代码评审，以及对照仓库里的测试、脚本和 `docs/e2e/` 证据逐条核验 PR 描述里"能证明的"结论。子 agent 只读、不改代码、不推送，可以重跑类型检查和单元测试，不重跑调用真实模型的 E2E。它的结论原样转给用户，确认的问题修掉之后才合并，并把审查结论写进 PR 描述。

## 改完代码后必须自检

提交或开 PR 之前，按顺序完成：

1. `npm run typecheck` 无错误
2. `npm test` 全部通过；新增逻辑要补测试
   - 改动引擎（`src/engine/`）时，`tests/engine.state-space.test.ts` 的穷举验证必须通过
3. 改动超过 100 行的 PR 必须做 E2E：用真实模型跑一次（`npm run e2e`），在 PR 里附日志或截图
4. 用 `/engineering:code-review` 评审本次改动，修掉确认的问题再提交；评审结论写进 PR 描述
5. 升级 dsh 版本时，先重跑 `poc/run-all.sh`
6. 合并前做一次独立子 agent 审查（见上面「唯一的例外」），修掉确认的问题

## 代码约定

- `src/workflow/`、`src/engine/` 是纯逻辑：不读写文件、不访问网络、不读时钟，可单测
- 外部数据（YAML、dsh 事件、模型输出、数据库行）只在边界解析成类型，内部信任类型
- dsh 只通过 `src/executor/dsh.ts` 接入；别的模块不直接引用 dsh 的包
- 任务 worktree 放在平台数据目录下，不放在 `/tmp`（没有 bwrap 时 `/tmp` 不受沙箱限制）
- 面向用户的文字用中文
