# 容器里的沙箱：实测记录（2026-11-24）

ADR-006 的沙箱结论来自这里。宿主机内核 6.18，Docker 29.9，cgroup v1；镜像是 Ubuntu 24.04 + Node 24 + bubblewrap 0.9.0。

## 1. bwrap 在哪些容器权限下能用

命令：`bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --die-with-parent true`，分别以 root 和 uid 1001 运行。

| `docker run` 选项 | 结果 |
|---|---|
| 默认 | `No permissions to create new namespace`（默认 seccomp 不让非特权进程建 user namespace） |
| `--security-opt seccomp=unconfined` | `Can't mount proc on /newroot/proc: Operation not permitted`（Docker 屏蔽的 /proc 路径挡住了挂新的 proc） |
| `--security-opt apparmor=unconfined` | 同默认 |
| `--cap-add SYS_ADMIN` | `pivot_root: Operation not permitted` |
| `--security-opt seccomp=unconfined --security-opt systempaths=unconfined` | 成功 |
| Docker 默认 seccomp 规则（moby/profiles 的 `seccomp/default.json`）末尾加一条不带能力要求的规则，放开 `unshare`/`setns`/`mount`/`umount2`/`pivot_root`/`clone`；不加 systempaths | 挂 proc 失败 |
| 同上 + `systempaths=unconfined` + `--cap-drop ALL` + `no-new-privileges`，uid 1001 | 成功 |
| `--privileged` | 成功 |

结论：bwrap 至少要去掉 Docker 对 `/proc` 的屏蔽（`systempaths=unconfined`）。这会让容器里的 root 能写 `/proc/sysrq-trigger` 这类文件。

## 2. 真实 dsh + 真实模型：agent 能写哪里、能不能读别的进程的环境

探针：`container-probe.mts`。它用 `src/executor/dsh.ts` 的 `DshExecutor` 起一个 `workspace-write` 的 agent，让 agent 用 bash 依次写自己的 worktree、别的任务的 worktree、数据目录根、`/tmp`，再数 `/proc` 里能看到几个进程，以及有几个进程的环境里能读到标记 `PROBE_MARKER_7f3e`。标记由 `docker run -e PROBE_SECRET=…` 放进平台进程的初始环境，交给 dsh 的环境里去掉了。写没写成以磁盘上有没有文件为准，`/proc` 的结果是 agent 的 bash 写出的文件。

| 运行 | 文件 | 自己的 worktree | 别的 worktree | 数据目录根 | 真实 `/tmp` | 看到的进程数 | 读到标记的进程数 |
|---|---|---|---|---|---|---|---|
| 默认权限，uid 1001（dsh 退到 Landlock） | `default.json` | 能写 | 拒绝 | 拒绝 | **能写** | 10 | 0 |
| `seccomp=unconfined` + `systempaths=unconfined`，uid 1001（dsh 用 bwrap） | `unconfined.json` | 能写 | 拒绝 | 拒绝 | 不能（私有 `/tmp`） | 6 | 0 |
| 默认 seccomp，平台 root（只留 SETUID/SETGID/CHOWN/DAC_OVERRIDE/FOWNER），dsh 经 `drop-to-agent.mjs` 降到 uid 1001 | `root-drop.json` | 能写 | 拒绝 | 拒绝 | 能写 | 10 | 0 |
| **最终配置**：`docker compose run`（`compose.yaml` 的 `cap_drop: ALL`、`no-new-privileges`、`/tmp:exec,size=4g`），uid 10001（eos），最终镜像 | `compose-final.json` | 能写 | 拒绝 | 拒绝 | 能写 | 9 | 0（同一容器里不在沙箱时读到 6 处，`unsandboxedMarkerHits`） |

前三行是调研阶段的手动运行：用的是普通 `docker run`、uid 1001、加缓存相关 ENV 之前的镜像。最后一行用的是最终的 compose 配置。

正对照：同一个镜像里，不在沙箱里的 uid 1001 进程 `grep -sl PROBE_MARKER_7f3e /proc/[0-9]*/environ` 能读到 5 处。所以 Landlock 下读不到，是因为 Landlock 挡住了对域外进程的 ptrace 类访问，不是因为标记不存在。

另外一项：平台以 root 运行、带着标记，以 uid 1001 起的普通子进程（模拟检查命令，不在沙箱里）读到 0 处，`cat /proc/1/environ` 被拒绝；以 root 起的子进程读到 5 处。

## 3. 依赖安装和缓存位置（最终配置）

探针：`deps-probe.mts`，用 `docker compose run --rm -v <本目录>:/probe:ro eos node --import tsx /probe/deps-probe.mts` 运行。agent 在沙箱里依次做下面几件事：
- `npm install <包>`；
- 用 corepack 的 pnpm 装包；
- 用 venv 装 pip 包；
- 往 dsh 的 native 缓存目录写文件；
- 按 package.json 装 devDependencies，并打印 `NODE_ENV`。

结果在 `deps-probe.json`：
- npm、pnpm、pip、devDependencies 都装上了；
- 写 native 缓存目录被拒绝（`Permission denied`），agent 的 shell 里 `NODE_ENV` 为空；
- `/tmp` 里只有 `cache/` 和 dsh 的输出暂存文件，没有 tsx 缓存和 Node 字节码缓存。

这次运行用的镜像里还设着 `npm_config_devdir`，之后删掉了，因为 npm 会对它打警告。它和这个探针的结论无关。

## 局限

- 这些是一次性的手动运行，命令写在上面，探针源码在本目录，但没有接进 `npm run` 脚本。第 1 节的 bwrap 结果只有这里的表格，没有保存命令输出。
- 只测了这一个内核。旧内核的 Landlock ABI 版本更低，dsh 会报告 `partial`；内核没有启用 Landlock 时 dsh 拒绝执行命令（fail closed），没有实测。
