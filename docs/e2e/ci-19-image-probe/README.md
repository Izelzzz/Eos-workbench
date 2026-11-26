# CI ⑤b 镜像的依赖探针：本地验证

`probe-runs.txt`：`.github/scripts/image-probe.ts` 在本地跑的两次。

1. **当前 Dockerfile 构建的镜像**：`docs/deploy.md`「执行器环境」表里的 13 条检查（以 `eos-agent`、断网运行）全部 ✓；三个用户的 uid、组和 `/data` 的属主也都对。退出码 0。
2. **反例**：在同一个镜像上删掉 `bwrap` 和 `pkg-config`、把 `/data` 的属主改成 root。这 3 项 ✗，其余 ✓，退出码 1，并输出中文说明。

平台镜像在 CI 上的结果，见这个 PR 的 `image-build` job 里「依赖探针」那一步。本地的基础镜像因为 Docker Hub 限流，改从 `mirror.gcr.io` 拉了同名标签。
