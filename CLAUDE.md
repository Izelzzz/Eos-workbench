# 本仓库的工作约定

## 写完代码后必须自检

每次改完代码、提交或开 PR 之前，按顺序完成：

1. `claude plugin validate .` 通过
2. 类型检查无错误（`tsc -p .`，需要 `.claude-plugin/types/` 已由引擎生成；否则用插件 API 声明文件单独配一个 tsconfig）
3. `claude plugin test .` 全部通过；新增逻辑要补测试
4. 用 `/engineering:code-review` 对本次改动做一次代码评审，修掉确认的问题后再提交；评审结论（发现了什么、改了什么、哪些留作 issue）写进 PR 描述

## 代码约定

- 纯逻辑放 `hooks/core/`，不依赖 `$`，可单测；`hooks/register.tsx` 只做引擎接入
- 校验器不允许把 `$` 赋值或作为参数传递：后台流程通过 `session.start` 里组装的 `io` 闭包调用引擎
- 面向用户的文字用中文
