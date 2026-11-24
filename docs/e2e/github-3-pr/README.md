# GitHub 接入 3/3：平台开 PR（真实模型 E2E）

## 怎么跑的

```
EOS_MASTER_KEY=<随机> EOS_E2E_REPO=https://github.com/Izelzzz/eos-e2e-sandbox EOS_E2E_GIT_TOKEN=<随机占位值> npm run e2e
```

- 远程模式下，`scripts/e2e.ts` 用 `feature-pr` 工作流。它是 feature 工作流后面加一个交付节点，检查只有一项 `{ platform: pull-request }`。
- 任务在私有仓库 `Izelzzz/eos-e2e-sandbox` 上用真实模型跑完，中途杀掉进程再续跑。
- 跑的是处理独立审查之后的代码（提交 a957f1d，已经合入了 #59）。处理审查之前，1255758 上也跑过一次，同样 15/15，当时开出的是 PR #1。

## 结果

15/15，见 `e2e-report.json`，完整输出见 `e2e-run.log`。

| 检查 | 依据 |
|---|---|
| 原有 8 项，克隆的 3 项，推送的 2 项 | 同 `docs/e2e/github-1-clone`、`github-2-push` |
| 开了 PR，检查结果带着 PR 链接 | `https://github.com/Izelzzz/eos-e2e-sandbox/pull/2` |
| 同一个分支再开一次时，复用同一个 PR；GitHub 上这个分支打开的 PR 只有一个 | 脚本在一个走代理的子进程里，用相同参数再调一次平台的 `openPullRequest`，得到 `reused: true`，地址也相同；再查 GitHub 接口，这个分支打开的 PR 只有 1 个 |

其他文件：

- `pull-request.json`：从 GitHub 接口读回的 PR #2。状态 open，`eos/t261124155107p5m` 合到 `main`，标题是需求的第一行。
- `task-links.png`：任务页「链接」一栏，同时显示分支和 PR #2。
- `large-changes.png`：改动很大时，改动区提示去 PR 页面看 diff。这次的真实任务只改了 2 个文件，触发不到这个提示，所以截图脚本 `scripts/pr-page-shots.mjs` 把改动接口的返回换成了 25 个文件。真实接口（2 个文件）下不显示提示，见 `page-shots.json` 里的 `smallNotice: 0`。

## 局限

- **认证由代理完成。** 平台持有的令牌是占位值，证明不了真令牌按正确的格式发给了 GitHub API（同前两个 PR）。
- **只用本地假接口测过的情况。** 以下情况都只在 `tests/mirror.test.ts` 里用假 GitHub 接口测过，没有在 GitHub 上真实触发：
  - 开 PR 被拒；
  - 没有改动；
  - 分支已有指向别的分支的 PR；
  - 旧任务没记下默认分支；
  - GitHub 返回 422；
  - 查和开之间别人刚开了一个；
  - 之前的 PR 已合并或被关闭。
- **"改动很大"的提示用的是替换后的数据。** 25 个文件的改动区截图是改写接口返回后拍的，不是真实任务的改动。
- **"改动很大"只验证了文件数。** 超过 20 个文件的提示有截图；超过 1000 行的那一支没有测试，也没有截图。
