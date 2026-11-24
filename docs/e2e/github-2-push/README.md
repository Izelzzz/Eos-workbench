# GitHub 接入 2/3：平台推送任务分支（真实模型 E2E）

## 怎么跑的

```
EOS_MASTER_KEY=<随机> EOS_E2E_REPO=https://github.com/Izelzzz/eos-e2e-sandbox EOS_E2E_GIT_TOKEN=<随机占位值> npm run e2e
```

- 远程模式下，`scripts/e2e.ts` 用 `feature-push` 工作流。它是在 feature 模板后面加了一个交付节点：一个没有评审角色的对话节点，检查只有 `{ platform: push }`。
- 任务在私有仓库 `Izelzzz/eos-e2e-sandbox` 上用真实模型跑完，期间按原有流程杀掉一次进程再续跑。
- 跑的是提交 7e18192 的代码，已合入包含 #52 的 main。

## 结果

13/13，见 `e2e-report.json`，完整输出见 `e2e-run.log`。

| 检查 | 依据 |
|---|---|
| 原有 8 项，加上 PR 1 的 3 项（记下远程仓库、worktree 在镜像上、数据目录里找不到令牌和认证头） | 同 `docs/e2e/github-1-clone` |
| 远程的任务分支和本地任务分支是同一个提交 | 两边都是 dcf6048。本地用 `git rev-parse HEAD` 读，远程用 `git ls-remote` 读，GitHub 上的结果另存在 `remote-branch.txt` |
| 推送检查通过，并带着分支链接 | 检查结果的 `links` 是 `https://github.com/Izelzzz/eos-e2e-sandbox/tree/eos/t261124151234hph` |

## 局限

- **认证由代理完成。** 平台持有的令牌是占位值。和 PR 1 一样，这次证明不了真令牌按正确的格式发出去了。
- **只在单元测试里验证的情况：**
  - 远程分支被别人改过时不强推、任务失败。
  - agent 自己提交了越界文件时不推送。
  - 平台动作失败后人工重试。
  - 任务中止后不推送。

  这几种都由 `tests/mirror.test.ts` 用本地 git 服务覆盖，没有在 GitHub 上真实触发过。
