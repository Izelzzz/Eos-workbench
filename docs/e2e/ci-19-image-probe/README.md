# CI ⑤b 镜像的依赖探针：本地验证

`probe-runs.txt`：`.github/scripts/image-probe.ts` 在本地跑的三次（检查清单改放 `.github/scripts/image-probe-checks.json` 之后的版本）。

1. **当前 Dockerfile 构建的镜像**：`image-probe-checks.json` 里的 16 条检查（以 `eos-agent`、断网运行；和 `docs/deploy.md`「执行器环境」的表一致）全部 ✓（C++ 那条在第一轮独立审查后改成真的编译）；三个用户的 uid、完整的组和 `/data` 的属主也都对。退出码 0。
2. **反例**：在同一个镜像上做代码评审举的几种回退：删 `bwrap`、`pkg-config` 和 `pnpm` 的 shim；删 ensurepip（相当于没装 python3-venv）；删 `stdio.h`（相当于缺 libc6-dev）；给 `eos-check` 多加 `eos-dsh` 组；把 `/data` 的属主改成 root。对应的 5 条检查 ✗，用户那一项 ✗ 并同时报出组和属主两个问题，其余 ✓，退出码 1，并输出中文说明。
3. **第一轮独立审查的反例**：删掉 C++ 头文件、把 npm 换成只会输出版本号的假脚本。C++ 那条（编译一个带 `<vector>` 的程序）✗，退出码 1。假的 npm 仍然 ✓：`npm --version` 只能证明有这个命令，npm 的版本由 Trivy 扫描把关。

平台镜像在 CI 上的结果，见这个 PR 的 `image-build` job 里「依赖探针」那一步。本地的基础镜像因为 Docker Hub 限流，改从 `mirror.gcr.io` 拉了同名标签。
