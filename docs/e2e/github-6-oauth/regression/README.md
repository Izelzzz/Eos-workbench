# 回归 E2E（真实模型，没配 App 和用户授权）

```
EOS_MASTER_KEY=<随机> EOS_E2E_REPO=https://github.com/Izelzzz/eos-e2e-sandbox EOS_E2E_GIT_TOKEN=<随机占位值> npm run e2e
```

- **跑的代码**：9944222，也就是自检和代码评审的修改都做完之后。这是这个 PR 唯一一次调用真实模型的 E2E。
- **结果**：15/15，见 `e2e-report.json`，完整输出见 `e2e-run.log`。GitHub 上开出了 eos-e2e-sandbox 的 PR #7，用同一个分支再开一次时复用了它。
- **证明了什么**：认证顺序改成「授权人 → App → 个人令牌 → 匿名」之后，没配 App 时的克隆、推送、开 PR 都没被改坏。
- **没证明什么**：认证由代理完成（同 #54），这次也不经过用户授权的代码。用户授权由 `../`（模拟 GitHub 的浏览器 E2E）和单元测试覆盖，真实验证在下一个 PR。
