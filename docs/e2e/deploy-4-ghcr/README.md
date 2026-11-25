# 镜像发布到 ghcr：本机验证

在本云环境按 `.github/workflows/image.yml` 的步骤跑，不登录、不推送。不调用模型。

| 文件 | 内容 |
|---|---|
| `image-smoke.txt` | 第一版的冒烟 `docker run --rm <镜像> eos --help`（Docker 默认能力）：退出码 0；`--cap-drop ALL` 时退出码 1 |
| `image-smoke-compose-caps.txt` | 独立审查后的冒烟（`image-build.sh`）：和 compose 一样的能力（只加 SETUID、SETGID、KILL）和 `no-new-privileges`，退出码 0；少了 KILL 时退出码 1、给出中文说明 |
| `image-publish-sim.txt` | 第一版 publish 步骤的模拟（评审后挪进 `image-build.sh`，内容相同）：`image-tags.ts` 算出的标签、按标签构建、OCI 标签写进镜像。用的是预发布版标签，只有一个标签 |
| `compose-pull.txt` | 用仓库里的 `compose.yaml`（服务带 `build:`）：`docker compose pull` 会拉 `EOS_IMAGE` 指定的镜像（用公开的 hello-world 代替还没发布的 ghcr 镜像） |
| `image-push.txt` | `image-push.sh` 用假的 `docker`、`curl` 跑：main 分支还是本提交时先推 `sha-` 再推 `main`；main 已经是更新的提交时跳过 `main`；版本号标签不查 main，`1.2.3` 和 `latest` 都推 |

本机构建比工作流多了 `--network host` 和代理的根证书（这个云环境出网要经过会解开 TLS 的代理），工作流里没有。

评审后的 `image-build.sh` 在本机构建时 Docker Hub 返回 429（拉基础镜像限流），整条路径以 PR 的 CI 里 `image-build` job 的结果为准：它在 GitHub 的 runner 上构建、冒烟、打印了 OCI 标签。

GitHub 上真正的发布（登录 ghcr、推送、从服务器拉取）要合并之后才能验证，见 PR 描述「证明不了的」。
