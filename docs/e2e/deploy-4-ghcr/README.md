# 镜像发布到 ghcr：本机验证

在本云环境按 `.github/workflows/image.yml` 的步骤跑了一遍，不登录、不推送。不调用模型。

| 文件 | 内容 |
|---|---|
| `image-smoke.txt` | 工作流里的冒烟检查 `docker run --rm <镜像> eos --help`：默认能力下退出码 0；反例 `--cap-drop ALL` 时退出码 1，给出中文说明。说明这一步能发现「镜像起不来、降不到 eos 用户」 |
| `image-publish-sim.txt` | publish job 的模拟：`image-tags.ts` 算出的标签、按这些标签构建、OCI 标签（source、revision、version）写进了镜像；`docker compose pull` 对带 `build:` 的服务也会拉 `EOS_IMAGE` 指定的镜像（用公开的 hello-world 代替还没发布的 ghcr 镜像） |

本机构建比工作流多了 `--network host` 和代理的根证书（这个云环境出网要经过会解开 TLS 的代理），工作流里没有。

GitHub 上真正的发布（登录 ghcr、推送、从服务器拉取）要合并之后才能验证，见 PR 描述「证明不了的」。
