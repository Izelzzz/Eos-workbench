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

### agent 和检查命令用独立用户运行（路线图第 3 项第 3 个 PR，分 ③b、③c 两步）

- 容器以 root 启动，镜像里的 `eos` 命令（`deploy/eos`）用 `setpriv` 降到平台用户 `eos`，只带着 `SETUID`、`SETGID`、`KILL` 三个能力（ambient；`KILL` 是 ③c 加的）。compose 去掉全部能力，只加回这三个。
  - 平台仍然是 `eos`、不是 root：数据卷里已有的文件都属于 `eos`，root 没有 `CHOWN`、`DAC_OVERRIDE` 就写不了它们，升级要么多给能力、要么迁移属主。平台留在 `eos` 不需要两者。
- **③b（#74）**：检查命令以 `eos-check` 运行，切换时清掉全部能力。实测（`docs/e2e/deploy-3b-check-user/`）：它读不到 `eos` 和 root 进程的环境，切换不回 `eos` 或 root，写不了 `eos.db` 和仓库；同一个扫描以 `eos` 运行时都能做到（正对照）。
  - worktree 归共用组 `eos-work`（`/data/worktrees` 带 setgid，平台的 umask 是 002），检查命令能写 agent 改过的文件。`/data/worktrees` 目录本身是 2755，组内不可写：检查命令不能把别的任务的 worktree 改名或换成符号链接（独立审查发现的，`probe-report.json` 的 `renameWorktreeDir`）。升级前的 worktree 在第一次启动时改成这个组。
  - 平台给别的用户的进程发不了信号，超时和中止时以 `eos-check` 运行 `kill` 结束检查命令的进程组。
  - 检查命令单独用一个用户，不和 agent 共用：同一个 uid 时，检查命令能读到 dsh 进程环境里的模型 key。
  - 检查命令拿到证书和不带账号密码的代理设置（用户选的方案）。带账号密码的代理不传，doctor 提示。
  - 平台的子进程不带这两个能力：dsh 经 `deploy/dsh-launch.mjs`、git 经镜像里的 `/usr/local/bin/git` 启动，先用 `setpriv` 清掉全部能力（代码评审发现：不清的话 dsh 在沙箱外启动的 MCP 服务和 git 能切换到 root、改写 `/app`）。实测真实 dsh 进程的能力是 0。dsh 由 SDK 以 `node <入口>` 启动，加不了命令前缀，所以包装是一个 Node 脚本，用 `process.execve` 把自己换成 setpriv 再换成 dsh：进程号不变，不多一层进程，平台的信号和看到的退出码都直接是 dsh 的。doctor 的 bwrap 探测在平台带着能力时也先清掉能力（bwrap 发现自己带着能力又不是 setuid 时会直接退出），和 dsh 在同样的条件下探测。
- **③c**：dsh 的入口（`deploy/dsh-launch.mjs`）在清掉能力的同时切换到 `eos-agent`，agent 和 dsh 启动的 MCP 服务也是这个用户。实测（`docs/e2e/deploy-3c-agent-user/`）：eos-agent 读不到平台（eos）和 1 号进程的环境，平台的主密钥对 agent 不再只靠沙箱。
  - agent 是 dsh 启动的，和 dsh 总是同一个用户：dsh 进程环境里的模型 key 对 agent 仍然只靠 Landlock，dsh 在沙箱外启动的 MCP 服务读得到它。要隔开得让 dsh 不从环境拿 key，这一版 dsh 做不到。
  - 平台加回 `KILL`：平台要给 dsh 发信号（SDK 关掉 dsh、换 key 后重起，#65 的路径），dsh 现在是别的用户。另一个办法是像检查命令那样以 `eos-agent` 的身份去杀，但要改 vendor 里 SDK 关闭进程的写法，用户选了加能力。平台的子进程照样清掉它。
  - dsh 的数据目录 `/data/dsh`：属于 `eos`、组 `eos-dsh`（只有 `eos` 和 `eos-agent`），2770。平台往里写能力面，dsh 写会话日志。dsh 建的会话目录是 0700、文件是 0600，平台以 `eos-agent` 的身份读（`readSessionLogAs`）。不给平台加 `DAC_READ_SEARCH`：那样平台什么文件都能读，范围比需要的大。
  - 平台读不到别的用户进程的工作目录（要 `SYS_PTRACE`），`procs.ts` 找不到 agent 留下的进程：撤销越界改动前以 `eos-agent` 的身份找、杀（和检查命令一样）。
  - 升级：旧的 `/data/dsh` 属于 `eos`，dsh 的文件多是 0700、0600，`eos-agent` 用不了，平台又没有 `CHOWN` 改不了属主。第一次启动平台时以 `eos-agent` 的身份复制一份，旧的改名留作备份。`.credentials.yaml` 不复制：dsh 要求它只有属主可读，新的 dsh 会重新生成（里面是 dsh 的浏览器会话授权，没有模型 key）。实测迁移后能续接升级前的会话。
  - dsh 的 native 模块缓存放到 `eos-agent` 的家目录：平台（eos）有自己的一份，不加载 `eos-agent` 能写的那份。

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
- Landlock 下 agent 能写 `/tmp`。平台和 dsh 会加载的缓存不能放在那里，否则 agent 往里放的代码会在沙箱外运行：关掉 tsx 的编译缓存和 Node 的字节码缓存；dsh 的 native 模块缓存放到平台用户的家目录。反过来，npm、pip、corepack 的缓存放到 `/tmp/cache`，因为 agent 写不了家目录。不设 `XDG_CACHE_HOME`：dsh 自己（沙箱外）也按它找缓存目录（例如 libreoffice-kit）。其中 dsh 和 agent 要用到的 5 个（`NARB_NATIVE_CACHE_DIR`、`NODE_DISABLE_COMPILE_CACHE`、`npm_config_cache`、`PIP_CACHE_DIR`、`COREPACK_HOME`）要在 dsh 的环境白名单（`AGENT_ENV_KEEP`）里按名字放行，否则到不了 dsh 和 agent。`TSX_DISABLE_CACHE` 只给平台进程自己用，不在白名单里。tmpfs 带 `exec`，因为 agent 跑测试、编译时要执行自己生成的文件；另外设了 4g 的大小上限。（部署 E2E 第一次运行时 native 缓存还在 `/tmp`，`noexec` 让 dsh 起不来；缓存移走后已经不依赖 exec。）

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
- ③b：`Dockerfile`（建 `eos-check` 和共用组 `eos-work`，以 root 启动，`EOS_CHECK_USER`、`EOS_DSH_LAUNCHER`）、`compose.yaml`（`cap_add: SETUID, SETGID`）、`deploy/eos`（降权入口）、`deploy/dsh-launch.mjs` 和 `deploy/git`（清掉能力）、`src/cli.ts`（dsh 入口可换）、`src/runner/check-user.ts`、`src/runner/checks.ts`、`src/runner/doctor.ts`（「检查命令的用户」「检查命令的代理」两项）。不在容器里、没有设置 `EOS_CHECK_USER` 时，检查命令只多拿到证书和代理变量，其余不变。
- ③c：`Dockerfile`（建 `eos-agent` 和组 `eos-dsh`，`EOS_AGENT_USER`）、`compose.yaml`（`cap_add` 加 `KILL`）、`deploy/eos`（带上 `KILL`，准备和迁移 `/data/dsh`）、`deploy/dsh-launch.mjs`（切换到 `eos-agent`）、`src/executor/dsh.ts`（会话日志的读法可替换；白名单加 `EOS_AGENT_USER`）、`src/runner/check-user.ts`（以别的用户读会话日志）、`src/runner/supervisor.ts`（结束 agent 留下的进程）、`src/runner/doctor.ts`（「agent 的用户」一项，「凭据隔离」都满足时是 ✓）、`src/cli.ts`。不在容器里、没有设置 `EOS_AGENT_USER` 时行为不变。

## 已知限制

- **模型 key 对 agent 只靠沙箱**：agent 和 dsh 是同一个用户（见上）。dsh 在沙箱外启动的 MCP 服务读得到模型 key。
- **平台进程自己能切换到任何用户，包括 root**（探针的正对照）：root 只有这三个能力，但拥有 `/app` 等 root 的文件。平台进程本来就可信。它启动的进程里，清掉了能力的有：dsh（和它启动的 agent、MCP 服务）、git、检查命令、bwrap 探测，以及撤销越界改动时的 `sh`、`rm`、`find`（`withoutCaps`，`docs/e2e/deploy-3c-agent-user/without-caps.txt`）。还带着的只有两个：
  - Landlock 探测：doctor 起一次 node-addon-system 自带的 `landlock-run`，参数固定，不碰 worktree。它由那个包自己启动，平台加不了前缀。
  - tsx 的 esbuild 服务进程：编译平台自己的源码，不读 worktree。它由 tsx 在平台进程里启动。
  - 新增直接启动子进程的地方，要同样用 `withoutCaps`。
  - 撤销越界改动时的符号链接：`git.ts` 先进入要删的路径的上一级目录，用 `pwd -P` 核对还在 worktree 里，再按相对路径 `rm -rf -- <名字>`，符号链接只删链接本身、不跟随（`tests/write-scope.test.ts`「撤销时不顺着上级目录的符号链接删到 worktree 外面」「撤销时上级目录已经被换成指向外面的链接：拒绝删除」等用例）。在那之前 agent 和检查命令留下的进程都已结束。
- **检查命令能读世界可读的文件**：`eos.db`（trace、加密的凭据）、所有仓库和 worktree。它写不了它们，也读不到主密钥，所以解不开凭据。
- **各任务的 worktree 都归 `eos-work`**：一个任务的检查命令能改别的任务的 worktree（以前和平台同一个用户时，它能改整个 `/data`）。这是完整性问题：任务 A 的仓库里的恶意依赖可以往任务 B 的 worktree 里写东西，随后被平台提交进 B 的分支。agent 在 Landlock 里写不了别的 worktree，但 dsh 在沙箱外启动的 MCP 服务可以。按任务分组或加 ACL 解决不了：所有任务用的是同一个 `eos-check`、`eos-agent`。可行的办法是检查命令也放进 Landlock（只能写自己的 worktree、家目录和 `/tmp`，node-addon-system 自带 `landlock-run`），或者按任务分配用户。建议作为路线图里单独的一项。
- **agent 和检查命令建的私有文件**：平台在提交、撤销之前把它们改回 worktree 的组并开放组读写（`shareWithGroup`）。在那之后、下一次提交之前新建的文件（例如检查命令跑完后又起的后台进程写的）不在这一步里。

- **Landlock 比 bwrap 弱的地方**：
  - `/tmp` 是同一个 tmpfs，所有任务都能读写：能看到彼此的临时文件和 dsh 的输出暂存文件，也能改共享的依赖缓存（任务之间可以互相投毒）。npm 的缓存按 hash 校验，pip 缓存和 corepack 下载的 pnpm、yarn 不校验。
  - 这几个缓存目录也会传给沙箱外的 MCP 服务（它们继承 dsh 的环境）。用 `npx`、`uvx` 这类命令启动的 MCP 可能运行 agent 放进缓存的代码，所以文档要求 MCP 预装、写绝对路径。根本的办法是按任务分开缓存，并且不让沙箱外的进程用 agent 可写的缓存，作为后续项。
  - 不放在 `/tmp` 的缓存是按已知的几种列出来的（tsx、Node 字节码、dsh 的 native 模块）。以后的依赖再往 `os.tmpdir()` 放会被加载的文件时，需要重新检查。
  - agent 能看到进程列表（只是读不到别的进程的环境）。
- **Landlock 只限制写，不限制读**：agent 能读整个 `/data`，包括别的任务的 worktree、所有仓库、`eos.db` 里所有任务的 trace、dsh 的会话日志。bwrap 的默认配置也是只读挂载整个根目录，在这一点上没有区别。按仓库或按人隔离读权限，要等登录和多人（路线图第 7 项）之后一起设计。
- **宿主机内核要支持 Landlock**：Linux 5.13 以上，并且 LSM 列表里启用了 landlock。较旧的 ABI 会报告 `partial`；完全没有时 dsh 拒绝执行命令（fail closed），任务会失败而不是不受限制地运行。`eos doctor` 的「沙箱」一项按 dsh 的顺序真正探测一次，报告实际会用的后端，都用不了时报 ✗（`docs/e2e/deploy-3a-doctor/`）。
- **没有登录**：非浏览器客户端可以伪造 Host，网络上能连到端口的人都能用。默认只绑 127.0.0.1 就是因为这个。
- **镜像约 2.6GB**：其中 dsh 的依赖约 930MB，编译工具链和 Python 约几百 MB。
