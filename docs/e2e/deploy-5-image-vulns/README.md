# 镜像去掉 Trivy 扫出的可修复高危漏洞：证据

改动：`Dockerfile` 里把 npm 换成 11.21.2，先按 sha512 校验再安装；运行镜像里删掉 typescript（只用来做类型检查的开发依赖）。

这些证据都在云端开发环境里跑。Docker Hub 有限流，所以基础镜像 `node:24.22.3-bookworm-slim`、`ubuntu:24.04` 改从 `mirror.gcr.io` 拉，再打上同名标签，内容和 Docker Hub 上同名标签的镜像一样。构建时用 `extra_ca` build secret 传入出网代理的根证书。

| 文件 | 内容 | 结果 |
|---|---|---|
| `trivy-before.txt` | 改动前的镜像（main f679c2a），用 #86 的扫描参数和豁免清单 | Node 自带的 npm 打包的 undici、brace-expansion 共 6 个，TypeScript 的 Go 编译器 15 个；退出码 1 |
| `trivy-after.txt` | 改动后的镜像，参数相同 | 0 个，只剩豁免的 4 条 undici（dsh 的依赖）；退出码 0 |
| `npm-sha512-mismatch.log` | 把 `NPM_SHA512` 改错后构建 | `sha512sum -c` 失败，构建失败 |
| `no-typescript-at-runtime.txt` | 改动后的镜像里跑 `npm ls typescript --all`，并在 `/app` 的 `src`、`deploy`、`scripts`、`node_modules` 里找 `require`/`import` typescript 的地方 | 镜像里没有任何一份 typescript；找不到引用。对照组：同样的写法找 `undici`，能找到 24 个文件，说明这种匹配写法确实能找到引用 |
| `check-user-npm-ci.txt` | 改动后的镜像里，以检查命令的用户 `eos-check` 跑 `npm install`、`npm ci`，不调用模型 | npm 11.21.2 能装包、能生成 lockfile、能按 lockfile 重装；退出码 0 |
| `e2e-report.json`、`e2e-run.log` | `scripts/deploy-e2e.ts` 用真实模型跑一次（mini 工作流），镜像在提交 6d3086e 上构建 | 11 项核对全部通过：容器里 `eos doctor` 没有 ✗、任务完成、检查命令 `npm test` 以 eos-check 运行并通过、改动提交到任务分支、重建容器后任务和 worktree 都还在；容器里是 npm 11.21.2 |

运行 E2E 用的 compose 覆盖文件只用于这个环境，没有提交。内容是 host 网络、经代理访问模型、信任代理的根证书，和 `docs/e2e/deploy-2-image` 那次一样。
