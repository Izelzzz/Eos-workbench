# GitHub 接入 4：GitHub App 的短期令牌（回归 E2E）

## 这次 E2E 证明什么

这个 PR 改了平台访问远程仓库时选认证的方式：
- 依次试 App、个人令牌、匿名；
- 托管平台只建一次；
- 换来的令牌进统一遮蔽。

真实的 GitHub App 要在用户的浏览器里注册，平台还没有注册页（下一个 PR）。所以这次 E2E 只跑**没有配置 App** 的情况，确认原来的克隆、推送、开 PR 没被改坏。

```
EOS_MASTER_KEY=<随机> EOS_E2E_REPO=https://github.com/Izelzzz/eos-e2e-sandbox EOS_E2E_GIT_TOKEN=<随机占位值> npm run e2e
```

跑的是提交 e9ec41f 的代码。结果 15/15，见 `e2e-report.json`。GitHub 上开出了 PR #3；用同一个分支再开一次，复用的还是 #3。完整输出见 `e2e-run.log`。

## App 这条路径的证据

都只来自假接口和单元测试，没有在真实 GitHub 上跑过：
- `tests/mirror.test.ts` 的「GitHub App」几条：测试服务用 App 的公钥校验 JWT，按仓库发令牌，令牌会过期。
- `tests/github-app.test.ts`：JWT 格式和签名；并发的换令牌请求只换一次；失败不缓存；没装到仓库。
