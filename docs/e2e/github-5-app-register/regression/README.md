# 回归 E2E（真实模型，没配 App）

```
EOS_MASTER_KEY=<随机> EOS_E2E_REPO=https://github.com/Izelzzz/eos-e2e-sandbox EOS_E2E_GIT_TOKEN=<随机占位值> npm run e2e
```

- **跑的代码**：处理完独立审查、合并 main 之后的 cacf803。之后的提交只改了文档。处理审查之前，在 164abcf 上也跑过一次，同样通过。
- **结果**：15/15，见 `e2e-report.json`，完整输出见 `e2e-run.log`。GitHub 上开出了 eos-e2e-sandbox 的 PR #6；用同一个分支再开一次时，复用的还是它。
- **这次证明了什么**：没配 App 时，克隆、推送、开 PR 都没被这个 PR 改坏。认证由代理完成（同 #54），这次不经过注册 App 的代码。
