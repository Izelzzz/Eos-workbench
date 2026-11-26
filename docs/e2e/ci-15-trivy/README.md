# CI ④ Trivy 镜像扫描：本地验证

在开发环境里跑的（2026-11-25，Trivy 0.76.2，按 digest 锁定）。这里构建不了平台镜像（Docker Hub 拉基础镜像返回 429），所以：

- 拦截路径用 Trivy 自己的镜像当被扫描对象，跑的是 `.github/scripts/image-scan.sh` 本身，只给 `docker run` 多加了 `--network host` 和代理证书（这个环境的出网代理在本机端口上）。本地是 root 运行，所以 `--user` 以非 root 运行、结束时删掉漏洞库缓存这一点要看 CI 的日志。
- 豁免清单用 `trivy fs` 扫 `package-lock.json` 验证，参数和 `image-scan.sh` 一样（`--severity HIGH,CRITICAL --ignore-unfixed --ignorefile --show-suppressed --exit-code 1`）。

平台镜像本身的扫描结果见这个 PR 在 CI 上 `image-build` job 的「扫描漏洞」一步：#87 修掉 Dockerfile 里的 21 个漏洞之后，6c8a57b 那次已经通过（0 个，只剩豁免的 4 条 undici）。

| 文件 | 内容 | 结果 |
|---|---|---|
| `1-block.txt` | 被扫描的镜像里有已有修复版本的高危漏洞 | 退出码 1，输出中文的处理说明 |
| `2-ignored.txt` | `.trivyignore.yaml` 原样 | undici 的 4 条在 Suppressed 一节，退出码 0 |
| `3-expired.txt` | 到期日改成过去 | 4 条不再豁免，退出码 1 |
| `4-otherversion.txt` | purls 改成别的版本 | 不匹配，4 条不再豁免，退出码 1（升级 undici 之后条目自动失效） |
| `5-expiring-soon.txt` | 到期日改成 3 天后 | 扫描前给出「豁免快到期」的提示（这份是独立审查前的版本，措辞后来改成「不到 N 天」，见 6） |
| `6-ignorefile-checks.txt` | 扫描前用 `trivyignore-check.ts` 校验豁免清单（两轮独立审查后加的），被扫描的是 #87 之后的平台镜像 | 原样：校验通过、Trivy 0 个、退出码 0；3 天后到期：提示并照常扫描；日期带引号、purls 为空、少 expired_at、流式写法：在跑 Trivy 之前报错退出 |

每个文件开头写了用的命令和 `.trivyignore.yaml` 的内容。
