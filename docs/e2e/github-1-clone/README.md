# GitHub 接入 1/3：克隆远程仓库（真实模型 E2E）

## 怎么跑的

```
EOS_MASTER_KEY=<随机> EOS_E2E_REPO=https://github.com/Izelzzz/eos-e2e-sandbox EOS_E2E_GIT_TOKEN=<随机占位值> npm run e2e
```

`scripts/e2e.ts` 先把 `EOS_E2E_GIT_TOKEN` 存进凭据存储，凭据名是 `github.com`。随后通过命令行在私有仓库 `Izelzzz/eos-e2e-sandbox` 上发起任务：feature 模板，真实模型。agent 提问时，由另一个进程回答。开发第一次完成后杀掉进程，再续跑。

跑的是提交 7573c82 的代码，结果 11/11，见 `e2e-report.json`，完整输出见 `e2e-run.log`。

| 检查 | 依据 |
|---|---|
| 原有的 8 项（任务完成、评审打回、会话续接、权限档位、提问、杀进程续跑、计量、`npm test`） | 和本地仓库的 E2E 相同 |
| 任务记下了远程仓库 | `meta.remote` 与地址解析的结果一致 |
| worktree 建在平台数据目录里的镜像上 | `meta.repo` 在 `data/repos/` 下 |
| 数据目录里找不到令牌（数据库、镜像、worktree、dsh 会话、日志） | 逐个文件按字节查找 |

`mirror.txt` 是镜像的现状：
- 配置文件里没有远程地址，也没有凭据。
- 镜像里只有两个引用：`refs/remotes/origin/main`（基线 86149f8，就是测试仓库的第一个提交）和任务分支。
- worktree 的 `.git` 文件指回镜像。

## 局限

- **令牌是占位值，认证由代理完成。** 这个容器访问 github.com 时，代理会用会话的 GitHub 连接做认证，并替换平台发出的认证头。所以这次 E2E 证明的是三件事：
  - 平台能经 HTTPS 克隆私有仓库、在上面跑完任务。
  - 平台持有的令牌没有落盘。
  - 平台发出的认证头不影响访问。

  它证明不了"真令牌按正确的格式发给了 GitHub"。这一点由 `tests/mirror.test.ts` 支撑：测试里起一个本地 git 服务，只接受格式完全正确的认证头，否则返回 401。
- 令牌无效、没有令牌、仓库不存在、空仓库这几种情况，只在本地 git 服务上测过。真实的 GitHub 上，认证失败的报错文字可能不同，平台按 401/403 和 "not found" 等关键字归类。
