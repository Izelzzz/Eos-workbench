# GitHub 接入 5：代码托管页，用清单流程注册 GitHub App

## 浏览器 E2E（模拟的 GitHub）

```
npm run build:web
node --import tsx scripts/forge-app-register-e2e.ts docs/e2e/github-5-app-register
```

- **平台这边是真的**：真实的 Web 服务、构建好的页面，在 Chromium 里点按钮。
- **GitHub 是模拟的**：`tests/git-server-main.ts`。它收下清单就生成一个 App（RSA 私钥现场生成），不经确认页直接跳回平台的回调；还模拟用 code 换凭据、查安装、换安装令牌，以及要认证的私有仓库 `acme/app`。

流程：打开「代码托管」页 → 填 App 名字、点注册 → 浏览器把清单表单提交到「GitHub」 → 跳回平台回调 → 平台用 code 换回 App 凭据并存进凭据存储 → 页面显示已注册和安装链接 → 把 App 装到 `acme/app` → 在页面上建任务，平台用 App 换来的令牌克隆私有仓库（凭据存储里没有个人令牌）。

结果 13/13，见 `report.json`。截图：

| 文件 | 内容 |
|---|---|
| `1-before.png` | 注册前：名字、组织、权限说明、回调地址 |
| `2-registered.png` | 跳回后：已注册的提示和安装链接 |
| `3-task.png` | 用 App 访问私有仓库建好的任务 |
| `4-390.png` | 390 宽，没有横向滚动 |

另外核对：接口响应、数据目录里的所有文件、任务日志里都找不到私钥的明文（含 JSON 转义和 base64 写法）。

## 局限

- **没有在真实的 GitHub 上注册。** 真实 GitHub 有确认页，会校验清单字段；App 名字全局唯一。模拟服务器不校验这些。真实注册要在用户的浏览器里做，安排在路线图第 3 项 PR ③（agent 和检查命令用独立用户运行）合并之后。
- GitHub Enterprise 的安装页地址取自 GitHub 返回的 App 页面地址，没有在 GHES 上验证。
