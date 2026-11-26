# .dockerignore 排除所有层级的 node_modules：证据

`image-app-files.txt`：在开发机上用 main 的 `.dockerignore` 和这个 PR 的 `.dockerignore` 各构建一次镜像，对比 `/app` 里的文件。

- before 带进了 `.github/lint/node_modules`（3000 多个文件），以及放在子目录里的 `*.log`、`.env`。
- after 这些都没有了，也没有多出任何文件。
- 另外少了 `poc/claude-code/logs/` 下 28 个已提交的 `*.log`：PoC 阶段的运行记录，平台运行时不读（`src`、`deploy`、`scripts/e2e` 里都没有引用 `poc/`）。
- 改动后的镜像冒烟通过。

CI 每次都是全新 checkout，没有 `.github/lint/node_modules`，所以对 CI 构建的镜像来说，唯一的变化是少了那 28 个 PoC 日志。
