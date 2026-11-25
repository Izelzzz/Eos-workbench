# ③c dsh 和 agent 用独立用户运行：验证记录

路线图第 3 项 ③c。都在容器里跑，用的是这个 PR 的镜像。本环境出网要走代理，所以多加了一个没有提交的 compose 文件（host 网络、代理和代理的根证书），见 `docs/e2e/deploy-2-image/README.md`。

| 文件 | 怎么来的 | 提交 | 调用模型 |
|---|---|---|---|
| `deploy-e2e-2-*.json/.log/.txt` | `scripts/deploy-e2e.ts`，最小工作流 `scripts/e2e/mini.yaml`（开发一次、平台跑 `npm test`），设了主密钥（生成的值） | e6a1498，工作区干净 | 是，第 2 次（用户在卡片上同意，要求任务简单一点） |
| `deploy-e2e-1-failed-*` | 同上，standard 工作流 | f5de7fc | 是，第 1 次，失败（见下） |
| `probe-report.json` | `scripts/agent-user-probe.ts` | 96cb2f5（处理三轮独立审查之后），工作区干净 | 否 |
| `migration-edge.txt` | `scripts/migration-edge-probe.sh eos-workbench:agent-user-probe`：迁移停在中间、删了标记重做 | 96cb2f5 的镜像 | 否 |
| `doctor-configs.txt` | `scripts/check-user-doctor-configs.sh eos-workbench:agent-user-probe` | 96cb2f5 的镜像 | 否 |
| `without-caps.txt` | 在容器里以平台的身份经 `withoutCaps` 跑一条命令 | 56ea601 的镜像 | 否 |

## deploy-e2e-1-failed：第一次 E2E 发现的问题

任务在第一步提交时失败：`open("docs/spec.md"): Permission denied`。dsh 写文件时，先在目标目录里建一个临时目录并 `chmod 0700`，这会清掉目录的 setgid，再在里面建 0600 的文件、改名过去。这样文件属于 `eos-agent` 的主组，平台（eos）读不了。修法（b0a38b8、c6bea86）：提交、撤销之前，以 `eos-agent` 的身份把它建的文件改回 worktree 的组，并开放组读写。容器里按 dsh 的写法复现过，修之后平台读得到。

## deploy-e2e-2-report.json：11/11

- doctor 没有 ✗，主密钥已设置（「凭据主密钥」✓）。
- 任务运行期间以 `eos-check` 扫描（`checkUserScan`）：真实 dsh（pid 138，uid 10003）、平台（uid 10001）、1 号进程的 `environ` 都是 EACCES，`secretsFoundIn` 为空（主密钥、模型 key 都没找到）。
- dsh 以 `eos-agent` 运行，能力是 0。
- 任务完成。`testUsers` 是 `eos-agent` 和 `eos-check`：agent 在沙箱里跑过 `npm test`，平台的检查命令以 `eos-check` 跑。
- agent 的改动提交到了任务分支（`commits`）：第一次失败的那一步。
- down 再 up 之后任务和 worktree 都在。
- 这个扫描是 `docker compose exec -u eos-check` 起的，代表检查命令（同一个用户、没有能力）。agent 在沙箱里读不读得到平台的环境没有在真实任务里扫：agent 是 `eos-agent`，和平台是不同的用户，读不到靠的是 uid，见下面探针的 `scanAsAgentOutsideSandbox`。

## probe-report.json

以平台的身份（eos，带 SETUID、SETGID、KILL）用真正的 `DshExecutor` 打开会话，不调用模型。

| 字段 | 结果 |
|---|---|
| `beforeUpgrade` | 旧镜像（③c 之前，dsh 以 eos 运行）留下一个会话，文件属于 eos、0700/0600 |
| `migrationLog`、`afterUpgrade` | 新镜像第一次启动平台时，以 eos-agent 复制了 `/data/dsh`，旧的改名为 `dsh.before-agent` |
| `doctor` | 「检查命令的用户」「agent 的用户」「凭据隔离」都是 ✓ |
| `probe.platform` | 平台进程 uid 10001，能力 `e0`（SETUID、SETGID、KILL），NoNewPrivs 1 |
| `probe.firstDsh` | dsh 的 uid 10003（eos-agent），能力 0 |
| `probe.sessionsAsAgent`、`platformReadsLogAsAgent` | 新会话的目录 0700、文件 0600，属于 eos-agent；平台以 eos-agent 的身份读到了（打开会话后 5 毫秒）。`platformReadsLogDirectly` 是 `ok`，是因为迁移过来的旧会话目录组内可读、glob 只匹配到了它，不说明平台能直接读新会话 |
| `probe.symlinkAttack` | 以 eos-agent 把平台的目录改名、往里面放链接、把平台写的文件换成链接，都被拒绝；`mcpWritesItsCwd` 是 ok（MCP 服务能写自己的工作目录）；`modes` 是这几个目录的权限（`/data/dsh` 带 sticky 位，`eos-*` 组内不可写，`mcp-cwd` 属于 eos-agent） |
| `probe.restartAfterKeyChange` | 换模型 key 后（#65 的路径），旧 dsh 结束了（平台用 KILL 给 eos-agent 的进程发信号），新 dsh 也是 eos-agent、能力 0 |
| `probe.scanAsAgentOutsideSandbox` | 以 eos-agent 在沙箱外扫描（代表 dsh 起的 MCP 服务，或者沙箱失效时的 agent）：只读到 dsh 自己的环境（同一个用户）；平台和 1 号进程读不到主密钥 |
| `probe.scanAsCheckUser` | 以 eos-check 扫描：什么都读不到 |
| `probe.leftover` | agent 留在 worktree 里、脱离了进程组的进程，以 eos-agent 的身份被结束了 |
| `probe.upgrade` | 升级前留下的会话迁移后找得到，用同一个 key 续接成功 |
| `probe.dshAfterClose` | 关掉执行器后没有剩下 dsh |

## doctor-configs.txt

- compose 的配置（加回 SETUID、SETGID、KILL）：Landlock ✓，三个用户相关的项都是 ✓。
- 放开 seccomp 和 `/proc` 屏蔽：bwrap ✓。
- 去掉 `cap_add`，或者只加回 SETUID、SETGID（③b 的 compose）：`eos` 用中文说明缺了哪个能力，退出码 1。

## without-caps.txt

平台进程带着 `e0`，经 `withoutCaps` 运行的命令（撤销越界改动时的 `sh`、`rm`、`find` 走这条路）能力是 0。

## migration-edge.txt

- 迁移停在两次 mv 之间：`eos web`、`eos resume` 都提示怎么恢复、退出码 1（`eos doctor` 照常运行），`dsh.agent-new` 里的数据还在，没有建空的 `/data/dsh`。
- 删了标记重做：已经是新布局的目录不再复制（没有新的备份目录），`eos-*` 仍属于 eos，`mcp-cwd` 是 2770，doctor 照常。从旧的 0777 收紧到 2770 的证据在 `probe-report.json` 的 `beforeUpgrade` 和 `afterUpgrade`。

## 真实模型 E2E 之后的改动

第 2 次 E2E（e6a1498）之后，处理两轮独立审查改了被测的代码：平台写的目录挪到 `eos-*`、`/data/dsh` 加 sticky 位、MCP 的工作目录交给 eos-agent、迁移的边界情况。这些由上面的探针在 96cb2f5 上验证（真实 dsh、打开会话、换 key 重启），没有再跑真实模型的任务。
