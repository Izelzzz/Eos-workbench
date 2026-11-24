# Docker Compose 部署（路线图 P0 第 3 项，PR 2）E2E 证据

运行命令：`DEEPSEEK_API_KEY=<key> node --import tsx scripts/deploy-e2e.ts`。本次在云端环境里运行，另加了一个只用于这个环境的 compose 覆盖文件（没有提交）：用 host 网络，经出网代理访问模型，并信任代理的根证书（构建时通过 `extra_ca` build secret 传入，运行时用 `NODE_EXTRA_CA_CERTS`）。除此之外用的就是仓库里的 `compose.yaml`。

| 文件 | 内容 |
|---|---|
| `e2e-report.json` | 6 项核对全部为 true；容器里的工具版本、doctor 输出、worktree 里 `npm test` 的结果、任务分支的提交、重建容器后的 `/data` |
| `e2e-run.log` | 每一步执行的 docker compose 命令和输出、agent 的提问和回答 |
| `doctor-with-master-key.txt` | 由 compose 注入 `EOS_MASTER_KEY` 时容器里的 doctor 输出（只显示指纹），以及在 `/data`、`/app`、`/tmp` 里搜主密钥的值，各 0 处 |
| `backup-restore.txt` | `docs/deploy.md` 里备份和恢复命令的实际运行：备份、`down -v`、恢复到新卷、启动后数据和属主都在、接口返回 200 |
| `sandbox/` | 容器里沙箱的实测记录，见 `sandbox/README.md`；`deps-probe.*` 是最终镜像里依赖安装和缓存位置的探针 |

## 结论

- 用最终的 `Dockerfile` 和 `compose.yaml`（提交 7737850）构建并启动。任务 `t261124141141ibm`（standard 工作流，deepseek-flash）完成：agent 提了 2 个问题，脚本经接口回答；评审打回一次，开发回应后通过（提交 c1、c3、c8）。
- 之前在 1ec1d78 和更早的镜像上也各跑通过一次，那两次的报告被这次覆盖了。
- worktree 里 `npm test` 通过，改动提交到了任务分支。
- `docker compose down`（删掉容器，保留卷）再 `up` 之后，任务状态不变，worktree 的最新提交和重建前一致。

## 第一次运行失败的记录

修复前的第一次运行，任务在第一步就失败了：`No usable prebuilt binary found in linux-x64-gnu`。原因是 compose 的 `tmpfs: /tmp` 默认是 `noexec`，dsh 的 native 加载器把 `.node` 缓存到 `/tmp` 再加载。当时 doctor 全是 ✓，没有发现这个问题。修复：`/tmp:exec`，后来又把 native 缓存移到了平台用户的家目录。这次失败的日志没有保留：脚本每次运行都会清空输出目录。
