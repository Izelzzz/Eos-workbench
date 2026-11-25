# GitHub 接入 6：用户授权（OAuth），以授权人的身份推送、开 PR

## 浏览器 E2E（模拟的 GitHub）

```
npm run build:web
node --import tsx scripts/forge-user-auth-e2e.ts docs/e2e/github-6-oauth
```

- **平台这边是真的**：真实的 Web 服务、构建好的页面，在 Chromium 里点按钮。
- **GitHub 是模拟的**：`tests/git-server-main.ts`。它模拟清单注册、安装、用户授权页（不经确认直接跳回）、换令牌和续期、查授权人（固定是 `octo`）、撤销授权，以及要认证的私有仓库 `acme/app`。
- **agent 是假的**：每次往 worktree 写一个文件，评审直接通过，交付阶段由平台推送并开 PR。

流程：
1. 注册 App，装到 `acme/app`；
2. 点「用 GitHub 账号授权」，跳到「GitHub」授权页，再跳回平台，页面显示 `@octo`；
3. 在页面上建任务，任务完成，开出 PR #1；
4. 点「撤销授权」。

结果 14/14，见 `report.json`。核对项：
- 克隆、推送、开 PR 都用授权人的令牌：模拟服务器记下了每个请求的认证头。
- 授权页的回调地址就是注册时登记的那个。
- 撤销时 GitHub 上的授权也撤销了，平台不再存令牌。
- 接口响应、数据目录里的所有文件、任务日志里都找不到用户令牌和刷新令牌。

| 截图 | 内容 |
|---|---|
| `1-registered.png` | 注册后：可以用 GitHub 账号授权 |
| `2-authorized.png` | 授权后：显示授权人，可以撤销或换人重新授权 |
| `3-task-pr.png` | 用授权人的身份推送、开 PR 的任务：链接里有分支和 PR #1 |
| `4-revoked.png` | 撤销后 |
| `5-390.png` | 390 宽，没有横向滚动 |

## 局限

- **没有在真实的 GitHub 上授权。** 真实的授权页、令牌有效期、续期时刷新令牌换新、撤销接口，都是按 GitHub 文档模拟的。真实验证在路线图第 2 项的下一个 PR 做，在用户电脑上用 Docker 跑。
- **续期、跨进程排队、授权失效**只有单元测试（`tests/mirror.test.ts`）覆盖，这次 E2E 里令牌没有过期。
