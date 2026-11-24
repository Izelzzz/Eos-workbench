# ADR-006：Docker Compose 部署与容器里的沙箱

- 状态：已采纳（2026-11-24）
- 关联：`docs/roadmap.md` P0 第 3 项；ADR-001（写入范围的更正）；ADR-005（凭据存储的已知限制）

## 背景

- 路线图定了：平台部署在团队共用的服务器上，agent 在服务端跑，凭据只由平台持有。
- 第 3 项要一个能直接用的部署：镜像、compose、数据持久化，并写清 agent 跑任务时环境里有什么。
- ADR-001 写过「部署镜像必须安装 bubblewrap」：dsh 在 Linux 上先用 bwrap，用不了时退到 Landlock。
- ADR-005 留了一个问题：平台进程的初始环境（`/proc/<pid>/environ`）里一直带着主密钥。能看到这个环境的进程都能读到它，包括检查命令；检查命令不在沙箱里，运行的是 agent 写的代码。

## 目标

1. `docker compose up -d` 就能跑起来；升级镜像不丢数据。
2. 没有登录时，默认不把平台暴露到网络上。
3. agent 只能写自己任务的 worktree；agent 和检查命令都读不到平台的主密钥和模型 key。
4. 不为了沙箱放宽容器本身的加固。

## 决定

### 沙箱：Docker 默认权限，dsh 用 Landlock

实测记录在 `docs/e2e/deploy-2-image/sandbox/`。

- 在 Docker 默认权限下，bwrap 建不了 user namespace，dsh 自动退到 Landlock。用真实 dsh 和真实模型测过：agent 能写自己的 worktree，写不了别的任务的 worktree 和数据目录。它也读不到其他进程的环境：Landlock 挡住了对域外进程的 ptrace 类访问，正对照是沙箱外同一用户能读到。
- 要让 bwrap 可用，除了放开 seccomp，还必须去掉 Docker 对 `/proc` 的屏蔽（`systempaths=unconfined`）。这样容器里的 root 能写 `/proc/sysrq-trigger` 等文件。而下一条要求平台以 root 启动，两者不能同时成立。
- 镜像里照样装 bubblewrap：dsh 先试 bwrap，失败只多一次探测。这样不同宿主机上的行为一致：宿主机或编排器放开了 user namespace 时，dsh 会自己用上 bwrap。

### agent 和检查命令用独立用户运行（路线图第 3 项第 3 个 PR）

- 平台以 root 启动，只保留切换用户需要的能力。dsh 以 `eos-agent` 运行，检查命令以 `eos-check` 运行。
- 实测：以别的 uid 运行的普通进程读不到 root 平台进程的环境。
- 检查命令单独用一个用户：它和 dsh 同一个 uid 时，能读到 dsh 进程环境里的模型 key。

### 访问：容器里监听 0.0.0.0，宿主机只绑 127.0.0.1

- compose 把端口绑到宿主机的 `127.0.0.1:4317`，团队成员用 SSH 隧道访问。要用域名访问时放在带认证的反向代理后面，并设 `EOS_PUBLIC_URL`（#53）。
- 没有登录：能打开这个地址的人权限都一样。不要绑到 `0.0.0.0` 或公网。

### 执行器环境：镜像里放常用工具链

- 镜像里有：git、Node 24 和 npm、corepack（pnpm、yarn）、Python 3（含 venv、pip）、build-essential、pkg-config。
- agent 不是 root，在 Landlock 下只能写 worktree，所以跑任务时装不了系统包。项目自己的依赖（`npm install`、`python3 -m venv .venv`）装在 worktree 里。需要别的系统依赖时，用一个 `FROM` 本镜像的 Dockerfile 自己加。

### 主密钥和模型 key：从宿主机的 `.env` 注入环境变量

- 按 ADR-005，主密钥只能是环境变量 `EOS_MASTER_KEY`，不写进容器的文件系统。compose 从同目录的 `.env` 读（chmod 600）。
- 不用 compose 的 `secrets`：它会把密钥挂成容器里的文件。

### 数据：一个命名卷挂到 `/data`

- `/data` 里有 `eos.db`、`dsh/`、`worktrees/`、`logs/`、`locks/`，用户的仓库放在 `repos/`。
- 升级镜像就是换容器，卷不动。`/tmp` 用 tmpfs，不进卷。
- Landlock 下 agent 能写 `/tmp`。平台和 dsh 会加载的缓存不能放在那里，否则 agent 往里放的代码会在沙箱外运行：关掉 tsx 的编译缓存和 Node 的字节码缓存；dsh 的 native 模块缓存放到平台用户的家目录。反过来，npm、pip、corepack 的缓存放到 `/tmp/cache`，因为 agent 写不了家目录。不设 `XDG_CACHE_HOME`：dsh 自己（沙箱外）也按它找缓存目录（例如 libreoffice-kit）。这些变量要在 dsh 的环境白名单（`AGENT_ENV_KEEP`）里按名字放行，否则到不了 dsh 和 agent。tmpfs 带 `exec`，因为 agent 跑测试、编译时要执行自己生成的文件；另外设了 4g 的大小上限。（部署 E2E 第一次运行时 native 缓存还在 `/tmp`，`noexec` 让 dsh 起不来；缓存移走后已经不依赖 exec。）

## 为什么不选其他方案

| 方案 | 不选的原因 |
|---|---|
| 放开 seccomp 和 `/proc` 屏蔽，用 bwrap，平台不用 root、不分用户 | 检查命令和平台是同一个用户，能读到主密钥。不满足目标 3 |
| bwrap + 独立用户 + 平台以 root 启动 | 容器里的 root 加上去掉 `/proc` 屏蔽，能改宿主机内核参数 |
| `--privileged` | 等于不隔离 |
| 主密钥放在文件里，用 compose `secrets` 挂进容器 | ADR-005 已经否决：文件在磁盘上，agent 的沙箱能读到 |
| 精简镜像，只放 git 和 Node | 用户确认要带上 Python 3 和编译工具链：很多仓库的测试离不开它们 |

## 影响范围

- 新增：`Dockerfile`、`.dockerignore`、`compose.yaml`、`docs/deploy.md`、`scripts/deploy-e2e.ts`。
- 第 3 个 PR 会改：`compose.yaml`（加上切换用户需要的能力）、`Dockerfile`（建 `eos-agent`、`eos-check`）、`src/executor/dsh.ts` 和 `src/runner/checks.ts`（以独立用户启动）。

## 已知限制

- **Landlock 比 bwrap 弱的地方**：
  - `/tmp` 是同一个 tmpfs，所有任务都能读写：能看到彼此的临时文件和 dsh 的输出暂存文件，也能改共享的依赖缓存（任务之间可以互相投毒）。npm 的缓存按 hash 校验，pip 缓存和 corepack 下载的 pnpm、yarn 不校验。
  - 这几个缓存目录也会传给沙箱外的 MCP 服务（它们继承 dsh 的环境）。用 `npx`、`uvx` 这类命令启动的 MCP 可能运行 agent 放进缓存的代码，所以文档要求 MCP 预装、写绝对路径。根本的办法是按任务分开缓存，并且不让沙箱外的进程用 agent 可写的缓存，作为后续项。
  - 不放在 `/tmp` 的缓存是按已知的几种列出来的（tsx、Node 字节码、dsh 的 native 模块）。以后的依赖再往 `os.tmpdir()` 放会被加载的文件时，需要重新检查。
  - agent 能看到进程列表（只是读不到别的进程的环境）。
- **Landlock 只限制写，不限制读**：agent 能读整个 `/data`，包括别的任务的 worktree、所有仓库、`eos.db` 里所有任务的 trace、dsh 的会话日志。bwrap 的默认配置也是只读挂载整个根目录，在这一点上没有区别。按仓库或按人隔离读权限，要等登录和多人（路线图第 7 项）之后一起设计。
- **宿主机内核要支持 Landlock**：Linux 5.13 以上，并且 LSM 列表里启用了 landlock。较旧的 ABI 会报告 `partial`；完全没有时 dsh 拒绝执行命令（fail closed），任务会失败而不是不受限制地运行。`eos doctor` 还不检查这一项。
- **没有登录**：非浏览器客户端可以伪造 Host，网络上能连到端口的人都能用。默认只绑 127.0.0.1 就是因为这个。
- **镜像约 2.6GB**：其中 dsh 的依赖约 930MB，编译工具链和 Python 约几百 MB。
