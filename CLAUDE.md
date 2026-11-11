# 本仓库的工作约定

## 写代码用 poteto mode

本仓库的项目设置启用了 pstack 插件（`cursor/plugins` 的 `pstack@cursor-plugins`，见 `.claude/settings.json`）。

- 任何写代码的任务（功能、修 bug、重构、评审修复）都按 poteto mode 执行：先完整读 `pstack:poteto-mode` 的 `SKILL.md`，再读它附带的 `docs/harness/claude-code.md`，按里面的映射把 Cursor 的名字换成 Claude Code 的（`Task` → `Agent`，其他 pstack skill 用 `Read` 读 SKILL.md 后照做）。
- 按 SKILL.md 匹配 playbook，把 playbook 的步骤原样列成待办，再开始做。
- 需要 Cursor 专属能力的步骤（Bugbot、Automations、cloud agent、`cursor-team-kit` 里的 `deslop` 等）按 harness 文档跳过，并在回复里写一行 `Skipped in Claude Code: <步骤>. <原因>.`。
- 下面的自检流程是 poteto mode 之外的附加要求，两者都要做。

## 写完代码后必须自检

每次改完代码、提交或开 PR 之前，按顺序完成：

1. `claude plugin validate .` 通过
2. 类型检查无错误（`tsc -p .`，需要 `.claude-plugin/types/` 已由引擎生成；否则用插件 API 声明文件单独配一个 tsconfig）
3. `claude plugin test .` 全部通过；新增逻辑要补测试
   - 改动状态机（`hooks/core/pipeline.ts`、`TRANSITIONS`、`Task` 类型）时，按 `.claude/skills/verify-stage-state-machine` 验证通过
4. 用 `/engineering:code-review` 对本次改动做一次代码评审，修掉确认的问题后再提交；评审结论（发现了什么、改了什么、哪些留作 issue）写进 PR 描述

## 代码约定

- 纯逻辑放 `hooks/core/`，不依赖 `$`，可单测；`hooks/register.tsx` 只做引擎接入
- 校验器不允许把 `$` 赋值或作为参数传递：后台流程通过 `session.start` 里组装的 `io` 闭包调用引擎
- 面向用户的文字用中文
