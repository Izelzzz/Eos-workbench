# ③b 检查命令用独立用户运行：验证记录

路线图第 3 项 ③b。三份证据，都在容器里跑，用的是这个 PR 的镜像。

| 文件 | 怎么来的 | 提交 | 调用模型 |
|---|---|---|---|
| `probe-report.json` | `scripts/check-user-probe.ts` | fbfb48e（处理独立审查之后），工作区干净 | 否 |
| `doctor-configs.txt` | `scripts/check-user-doctor-configs.sh eos-workbench:check-user-probe` | fbfb48e 的镜像 | 否 |
| `deploy-e2e-report.json`、`deploy-e2e-run.log` | `scripts/deploy-e2e.ts`（真实模型，一个 standard 任务） | 49b365a，工作区干净；之后处理独立审查改了 `deploy/eos`（worktrees 目录 2755）和撤销前清理进程的写法，没有重跑 | 是，这个 PR 唯一的一次 |

本环境出网要走代理，所以两个脚本都加了一个只在本环境用的 compose 文件：host 网络、代理地址和代理的根证书。这个文件没有提交，内容见 `docs/e2e/deploy-2-image/README.md`。

## probe-report.json

以平台的身份运行，用户是 eos，带着 SETUID、SETGID，和 `deploy/eos` 启动平台时一样。脚本调用平台真正的 `runChecks`，检查命令跑 `scripts/check-user-scan.mjs`；作为对照，平台用户直接跑同一个扫描。扫描时有两个进程在跑：一个真实的 dsh（经 `EOS_DSH_LAUNCHER` 启动，环境里有模型 key），另一个是代替 dsh 的 `sleep`（环境里有模型 key）。主密钥和模型 key 都是这次生成的假值。

| 字段 | 结果 |
|---|---|
| `probe.viaCheck.scan` | uid 10002（eos-check），能力全是 0。`secretsFoundIn` 为空，读每个 eos 和 root 进程的 `environ` 都是 EACCES。`setpriv` 切换到 root、eos 都失败。worktree 里的文件能写；`eos.db`、仓库文件、eos 的家目录、`/data/worktrees` 本身写不了；`eos.db` 和仓库文件读得到 |
| `probe.control.scan` | 平台用户能读到 8 个进程的密钥（包括真实的 dsh），能切换到 root，能写上面那几个文件：正对照 |
| `probe.viaCheck.scan.renameWorktreeDir`、`writeOutsideWorktree` 里的 `/data/worktrees/made-by-check` | 检查命令不能把 worktree 目录改名，也不能在 `/data/worktrees` 下新建（EACCES）：它没法把别的任务的 worktree 换成符号链接。对照组（平台用户）能改名 |
| `probe.realDsh` | 真实 dsh 进程的 CapEff、CapAmb 都是 0；包装用 `process.execve` 换成 dsh，进程号不变 |
| `probe.gitCaps` | 平台调用的 git 起的子进程没有能力（`/usr/local/bin/git` 包装） |
| `probe.gitCheck` | 检查命令里跑 `git status`、`git diff --check`、`git log` 通过 |
| `probe.timeout` | 卡住的检查命令 2.5 秒内被结束，没有留下 eos-check 的进程 |
| `upgraded`、`oldWorktreeWritableByCheckUser` | 先用旧镜像（`eos-workbench:local`，检查命令还和平台同一个用户）在数据卷里留一个 worktree，换成新镜像后，它改成了 `eos-work` 组，eos-check 能写；`/data/worktrees` 本身是 2755 |
| `platformProcess` | 平台进程带着 `c0`（SETUID、SETGID），NoNewPrivs 是 1，umask 是 0002 |

## doctor-configs.txt

- compose 的配置：Landlock，检查命令的用户 ✓。
- 放开 seccomp 和 `/proc` 屏蔽：bwrap ✓。对照组带着平台的能力直接跑 bwrap，退出码 1（`Unexpected capabilities but not setuid`）；清掉能力后退出码 0。所以 doctor 的探测要先清掉能力，才能和 dsh 在同样的条件下探测。
- 去掉 `cap_add`：`eos` 用中文说明缺了什么，退出码 1。

## deploy-e2e-report.json

9 项检查全部通过：

- doctor 没有 ✗。
- 任务运行期间，以 eos-check 扫描：真实 dsh 进程（`dshPids`）的环境读不到，`secretsFoundIn` 为空。
- dsh 进程的能力是 0。
- 任务完成。
- 平台的检查命令 `npm test` 以 eos-check 运行：`testUsers` 里有 eos-check，eos 来自 agent 在沙箱里跑的 npm test。
- worktree 里 `npm test` 通过。
- 改动提交到了任务分支。
- down 再 up 之后，任务和 worktree 都还在。
