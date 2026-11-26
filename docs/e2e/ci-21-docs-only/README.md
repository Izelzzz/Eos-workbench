# 纯文档 PR 跳过重的检查：实测

临时 PR #96（标题「临时，验证用，不合并」）：base 是这个 PR 的分支 `claude/ci-21-docs-only`（提交 9c84386，已经有 `.github/scripts/docs-only.ts`），改动只是 `docs/roadmap.md` 末尾加了一个空行（提交 a6d459d）。记完就关掉了；分支 `claude/ci-21-docs-only-probe` 用 git 推送删除时被这个环境的代理断开，没删成，请在 GitHub 上手动删除。

注意：独立审查后改成只有指向默认分支（main）的 PR 才会判为纯文档，所以合并后不能再用「base 是 PR 分支」的方法复现这次实测；合并后指向 main 的纯文档 PR 会走同样的路径。

## 实际跑出来的检查（2026-11-26，GitHub 的 check runs）

| 检查 | 结论 | 开始 → 结束（UTC） |
|---|---|---|
| changes-ci | success | 14:18:25 → 14:18:42 |
| changes-image | success | 14:18:26 → 14:18:40 |
| changes-codeql | success | 14:18:27 → 14:18:42 |
| changes-deps | success | 14:18:26 → 14:18:43 |
| gitleaks | success | 14:18:26 → 14:18:39 |
| pr-checklist | success | 14:18:25 → 14:18:37 |
| typecheck | **skipped** | 14:18:43 |
| unit-test | **skipped** | 14:18:43 |
| build-web | **skipped** | 14:18:43 |
| lint | **skipped** | 14:18:43 |
| format | **skipped** | 14:18:43 |
| e2e-fake-model | **skipped** | 14:18:43 |
| image-build | **skipped** | 14:18:40 |
| codeql-analyze | **skipped** | 14:18:43 |
| dependency-review | **skipped** | 14:18:44 |
| image-publish | skipped | （PR 上一向跳过） |

- 被跳过的 9 个检查都以原来的名字出现，结论是 `skipped`（不是「没触发」）。GitHub 的分支保护把 skipped 的必需检查当作通过。
- 从第一个检查开始到最后一个结束约 20 秒；跑全套时最慢的 e2e-fake-model、image-build 各要 2 分多钟。
- 没有出现单独的 `CodeQL` 代码扫描检查（这个仓库现在没有开代码扫描的合并保护）。
- `changes-ci` 的日志：从 base 取到脚本，输出「纯文档 PR（1 个文件），跳过重的检查」，`docs_only` 设为 true。
