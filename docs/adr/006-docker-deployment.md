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
  - dsh 的数据目录 `/data/dsh`：属于 `eos`、组 `eos-dsh`（只有 `eos` 和 `eos-agent`），3770。dsh 写会话日志。平台写的能力面和 dsh 进程的工作目录放在 `eos-profiles/`、`eos-process-cwd/`，启动时建好、2755，平台写之前核对它们是自己的真目录（`platformDir`）。MCP 服务的工作目录 `mcp-cwd/` 属于 eos-agent：MCP 服务要在里面写，平台只把路径交给 dsh、不往里写。迁移不复制 `eos-*`，复制完重新建；迁移停在中间时平台不启动（`deploy/eos` 退出码 1），避免下一次迁移删掉复制好的数据（第二轮独立审查发现）。独立审查发现：原来这些目录组内可写、`/data/dsh` 没有 sticky 位，eos-agent（例如 dsh 起的 MCP 服务）能把它们换成链接，让平台顺着链接覆盖 `eos.db`。dsh 建的会话目录是 0700、文件是 0600，平台以 `eos-agent` 的身份读（`readSessionLogAs`）。不给平台加 `DAC_READ_SEARCH`：那样平台什么文件都能读，范围比需要的大。
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

### 镜像发布：GitHub Actions 推到 ghcr（第 3 项最后一个 PR）

- 背景：之前只能在服务器上 `docker compose up --build`，每台服务器都要构建约 2.6GB 的镜像、要能访问 npm 和 apt 源。
- 目标：服务器直接拉镜像；能指定版本、能回退。
- 决定（用户在卡片上确认）：
  - 镜像名 `ghcr.io/izelzzz/eos-workbench`，和仓库同名，公开，拉取不用登录。镜像里没有密钥，key 都在运行时从 `.env` 传入。
  - `v*` 标签发布版本号，正式版同时发布 `latest`；合并到 main 发布 `main` 和 `sha-<短提交号>`；每个 PR 都按同样的步骤构建和冒烟、不推送（镜像里有 `src/`、`web/` 的构建，按路径触发会漏）。
  - `compose.yaml` 不改：默认仍在本地构建；用发布的镜像时在 `.env` 里设 `EOS_IMAGE`。
  - 工作流只用 GitHub 自带的 `docker` 命令和 `GITHUB_TOKEN`，不引入第三方 action；有写包权限的只有发布那个 job，PR 的 job 只读。标签由 `.github/scripts/image-tags.ts` 算（有单元测试），构建和冒烟在 `.github/scripts/image-build.sh`，PR 和发布共用。main 上每个提交单独一组并发，不会因为连续合并跳过中间提交的 `sha-` 标签；几次发布可能并行，浮动标签 `main` 推送前核对 main 分支还指向本提交（`.github/scripts/image-push.sh`）。冒烟用和 compose 一样的能力。
  - 推送前跑一次 `eos --help`：镜像能启动，平台的启动包装能降到 `eos` 用户。
- 包第一次发布后要由仓库所有者在 GitHub 的包设置里改成公开一次，工作流做不了。

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
- 镜像发布：`.github/workflows/image.yml`、`.github/scripts/image-tags.ts`（和测试）、`.github/scripts/image-build.sh`、`.github/scripts/image-push.sh`、`docs/deploy.md`「用发布的镜像」。

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

## 部署的实现细节

本节记录 Docker 部署现在是怎样实现的，以及每一处的理由。操作步骤在 `docs/deploy.md`。

### 用户和权限

#### 四个用户

| 用户 | 运行什么 | 能读 | 能写 |
|---|---|---|---|
| root | 只有 1 号进程（`docker-init`），以及 `docker compose exec` 不加 `-u` 时的命令 | 只有 `SETUID`、`SETGID`、`KILL` 三个能力，读写不了别的用户的文件 | 同左 |
| `eos` | 平台、git；平台进程自己带着 `SETUID`、`SETGID`、`KILL` | `/data` 全部（dsh 的会话日志以 `eos-agent` 的身份读）、自己进程的环境（主密钥） | `/data` 全部，`/data/dsh` 里 dsh 自己建的 0700 目录除外 |
| `eos-agent` | dsh、agent、dsh 启动的 MCP 服务 | 世界可读的文件、`/data/dsh`、dsh 进程的环境（模型 key；agent 在 Landlock 里读不到）；读不到 `eos` 和 root 进程的环境 | dsh：`/data/dsh`（共用组 `eos-dsh`）、worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；agent 在 Landlock 里只能写自己的 worktree 和 `/tmp` |
| `eos-check` | 检查命令 | 世界可读的文件，包括 `/data` 下大部分（`eos.db`、仓库、worktree）；读不到别的用户进程的环境，进不了 `/data/dsh` | worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；写不了 `eos.db`、`repos/`、`eos` 的家目录 |

把检查命令和 agent 放在独立用户下的目的：它们运行的是 agent 写的代码，不能读到平台进程环境里的主密钥。

#### 能力

- compose 去掉全部能力，只加回 `SETUID`、`SETGID`、`KILL`。`no-new-privileges` 保持生效。
- `eos` 命令以 root 启动，降到 `eos` 时保留这三个能力（ambient）。
- 平台用 `SETUID`、`SETGID` 把检查命令切换到 `eos-check`、把 dsh 切换到 `eos-agent`；用 `KILL` 给它们的进程发信号（关闭 dsh、结束超时的命令）。
- 切换时清掉全部能力，所以检查命令和 dsh 不能切换回 `eos` 或 root。

#### 哪些进程不带能力

规则：平台启动的进程只要会运行仓库代码或第三方程序，就先用 `setpriv` 清掉全部能力。

| 进程 | 启动方式 | 是否带能力 |
|---|---|---|
| dsh、agent、dsh 在沙箱外启动的 MCP 服务 | `deploy/dsh-launch.mjs`：清掉能力并切换到 `eos-agent` | 否 |
| git | `/usr/local/bin/git`（`deploy/git`） | 否 |
| 检查命令 | 切换到 `eos-check` 时清掉能力 | 否 |
| 平台借 `eos-check`、`eos-agent` 的身份运行的辅助命令 | 切换用户时清掉能力 | 否 |
| 撤销越界改动用的 `sh`、`rm`、`find` | 平台启动前清掉能力 | 否 |
| Landlock 探测（doctor 运行一次 node-addon-system 自带的程序） | 平台直接启动 | 是 |
| tsx 的 esbuild 服务进程（编译平台自己的源码） | 平台直接启动 | 是 |

仍带能力的两个进程都不接触 worktree，也不运行仓库里的代码。

#### 目录的归属和权限

| 目录 | 属主、组、权限 | 设计目的 |
|---|---|---|
| `/data/dsh` | `eos`、组 `eos-dsh`、3770（带 sticky 位） | dsh 在里面写会话日志等目录；检查命令不在 `eos-dsh` 组里，进不去 |
| `/data/dsh/eos-profiles/`（能力面）、`/data/dsh/eos-process-cwd/`（dsh 进程的工作目录） | 平台启动时创建，2755 | `eos-agent` 只读。上一级 `/data/dsh` 的 sticky 位使它不能改名或删除这两个目录；平台写入前还核对它们不是符号链接 |
| `/data/dsh/mcp-cwd/` | 属于 `eos-agent` | MCP 服务在里面写缓存和日志；平台不往里写 |
| dsh 创建的会话目录 | 0700，只有 `eos-agent` 能读 | 平台以 `eos-agent` 的身份读取（`src/runner/check-user.ts` 的 `readSessionLogAs`） |
| `/data/worktrees` | 2755，带 setgid，组 `eos-work` | 目录本身组内不可写：检查命令不能把别的任务的 worktree 改名或换成符号链接 |
| 各任务的 worktree | 组 `eos-work`，平台的 umask 是 002 | 检查命令能写 agent 改过的文件 |

#### 平台如何处理别的用户留下的进程和文件

平台读不到别的用户进程的工作目录，也可能读不了它们创建的文件，所以在两个时点借用它们的身份操作。

| 时点 | 平台做什么 | 原因 |
|---|---|---|
| 撤销越界改动之前 | 以 `eos-check`、`eos-agent` 的身份找出并结束它们留在 worktree 里的进程 | 平台自己看不到这些进程的工作目录 |
| 提交、撤销越界改动之前，以及检查命令结束之后 | 以 `eos-agent`、`eos-check` 的身份把它们在 worktree 里创建的文件改回 worktree 的组，并开放组读写 | dsh 写文件时经过一个 `chmod 0700` 的临时目录，文件落在 `eos-agent` 自己的组里、权限 0600，平台读不了 |

#### 从旧版本升级

适用于 dsh 以 `eos` 运行的旧版本（`/data/dsh` 里的文件属于 `eos`）。

**自动迁移。** 新版本第一次启动平台时：

1. 以 `eos-agent` 的身份把 `/data/dsh` 复制到 `/data/dsh.agent-new`。不复制 `.credentials.yaml`（dsh 自己的浏览器会话授权，dsh 会重新生成）。
2. 把旧目录 `/data/dsh` 改名为 `/data/dsh.before-agent`。
3. 把 `/data/dsh.agent-new` 改名为 `/data/dsh`。
4. 写标记文件 `/data/.dsh-agent`。

进行中的任务能续接原来的 dsh 会话。确认任务正常后可以删除 `dsh.before-agent`。

**迁移被打断。** 在第 2 步和第 3 步之间被打断时，`/data/dsh` 不存在而 `/data/dsh.agent-new` 存在。此时除 `eos doctor` 外，`eos` 的命令（启动平台、`run`、`resume` 等）都不运行并给出提示。手工恢复：

```bash
docker compose run --rm -u eos eos mv /data/dsh.agent-new /data/dsh
docker compose up -d
```

**worktree 的组。** 升级前创建的 worktree 在第一次启动时改为 `eos-work` 组。`/data/.worktrees-group` 是已完成的标记。

**不再使用的旧目录。** 升级后遗留的 `/data/dsh/profiles/<指纹>/`、`/data/dsh/process-cwd/` 不再使用，可以删除。它们属于 `eos-agent`，所以以 `eos-agent` 的身份删除，例如：

```bash
docker compose run --rm -u eos-agent eos rm -rf /data/dsh/process-cwd
```

#### 限制

- agent 和 dsh 是同一个用户。agent 读不到 dsh 进程环境里的模型 key，只依赖 Landlock。
- dsh 在沙箱外启动的 MCP 服务读得到模型 key。
- 服务器的代理地址带账号密码时，这个地址会进入 dsh 和 agent 的环境。

### 沙箱

dsh 用 Landlock 限制 agent。镜像里装了 bubblewrap，但在 Docker 默认权限下不可用；启用它需要放宽容器的 seccomp 和 `/proc` 屏蔽，因此没有采用（见 ADR-006）。

#### 沙箱限制什么

- **写入范围**：agent 只能写自己任务的 worktree 和 `/tmp`，写不了别的任务和数据目录。
- **别的进程的环境**：agent 读不到 dsh 和平台进程的 `/proc/<pid>/environ`，即读不到模型 key 和主密钥。

#### 沙箱不限制什么

下表后三行是 Landlock 相对 bwrap 的差别：bwrap 下每个任务有私有的 `/tmp` 和单独的进程号空间。

| 不限制的 | 后果 |
|---|---|
| 读文件 | agent 能读整个 `/data`：别的任务和别的成员的 worktree、`/data/repos` 下所有仓库、`eos.db`（所有任务的 trace）、`/data/dsh` 的会话日志。放进这台服务器的仓库和任务，对所有任务的 agent 可见 |
| `/tmp` | 同一容器里的任务共用 `/tmp`，并且都能写。能读到别的任务的临时文件和 dsh 的输出暂存文件（`/tmp/dsh-spill-*`） |
| 共享的依赖缓存 | 一个任务的 agent 放进缓存的内容会被下一个任务使用。npm 按 lockfile 里的 hash 校验包；pip 的缓存和 corepack 下载的 pnpm、yarn 没有这种校验 |
| 进程列表 | agent 能看到进程列表 |

#### 模型 key 的保护依赖沙箱生效

这一版 dsh 只能从进程环境里得到模型 key，所以模型 key 在 dsh 进程的环境里。

- 验证过的配置：本镜像、这份 compose、内核 6.18。在这个配置下 Landlock 挡住了 agent 读取 dsh 和平台进程的环境。
- Landlock 没有生效时（内核不支持，或以别的方式运行而没有经过沙箱），同一用户的 agent 能读到模型 key。
- 更换宿主机内核后，重新运行探针确认。探针是 `docs/e2e/deploy-2-image/sandbox/modelkey-probe.mts`，运行方法见同目录 `README.md` 第 4 节。

#### 内核不支持 Landlock 时

- dsh 拒绝执行命令，任务失败，不会在没有限制的状态下运行。
- `eos doctor` 的「沙箱」一项实际探测一次：按 dsh 的参数启动一次 bwrap，实际施加一次 Landlock 规则。两者都不可用时报 ✗。
- doctor 不检查 dsh 本身能否启动。doctor 全部为 ✓ 时，任务仍可能在第一步失败。

#### 会被加载的缓存不放在 `/tmp`

agent 能写 `/tmp`。平台和 dsh 会加载的缓存如果放在那里，agent 写入的代码就会在沙箱外运行。因此：

| 缓存 | 处理 |
|---|---|
| tsx 的编译缓存 | 关闭 |
| Node 的字节码缓存 | 关闭 |
| dsh 的 native 模块缓存 | 放在平台用户的家目录（`NARB_NATIVE_CACHE_DIR`） |

例外：检查命令的环境里没有关闭字节码缓存的开关，npm 会在 `/tmp/node-compile-cache` 留下缓存（属于 `eos-check`），之后的检查命令会加载它。检查命令本来就在沙箱外运行 agent 改过的代码，这不会让 agent 获得更多权限。

`/tmp` 挂载为可执行，是因为 agent 运行测试和编译时要执行自己生成的文件。

#### MCP 服务的启动方式

**不要用 `npx`、`pnpm dlx`、`uvx`、`pipx run` 这类下载后立即运行的命令启动 MCP 服务。**

- MCP 服务运行在沙箱外，并继承 dsh 的环境，包括指向 `/tmp/cache` 的依赖缓存设置。
- 用这类命令启动时，它可能运行 agent 放进缓存的代码。
- 做法：把 MCP 服务安装进派生镜像（见 `docs/deploy.md` 的「增加系统依赖」），在模板里写它的绝对路径。

#### 模型 key

- 平台先读凭据存储里名为 `deepseek` 的凭据，没有时才读 `.env` 里的 `DEEPSEEK_API_KEY`。第一次启动只能依靠 `.env`。
- 启动后可以在 Web 的凭据页添加 `deepseek`，再从 `.env` 删掉这一行并执行 `docker compose up -d`。
- 两处都没有时平台不启动，compose 会不断重启容器，`docker compose exec` 不可用。查看原因用 `docker compose logs eos` 或 `docker compose run --rm eos eos doctor`。

#### 主密钥

- `EOS_MASTER_KEY` 是凭据存储的主密钥（ADR-005）。
- 它只以环境变量的形式进入容器，不写进容器的文件系统。

#### `eos doctor` 在这份 compose 下的结果

| 检查项 | 预期结果 | 失败时 |
|---|---|---|
| 沙箱 | Landlock。镜像里装了 bwrap，但在 Docker 默认权限下不可用 | bwrap 和 Landlock 都不可用时为 ✗，平台不启动 |
| 检查命令的用户 | 实际切换一次到 `eos-check` 并成功 | 切换失败（例如 compose 里去掉了 `cap_add`）时为 ✗，平台不启动；不会退回到用平台用户运行检查命令 |
| 凭据隔离 | ✓：检查命令读不到主密钥和模型 key；agent 读不到主密钥，读不到模型 key 只依赖沙箱 | — |

#### 平台目录里没有 typescript

平台自己的 `/app` 不带 typescript：它只是用于类型检查的开发依赖，其编译器二进制有漏洞。

- 在容器的 `/app` 下执行 `npm run typecheck` 会报 `tsc: not found`。类型检查在 CI 和开发机上进行。
- 任务仓库自己的 typescript 照常安装在 worktree 里，不受影响。

#### 缓存位置

家目录在沙箱里不可写，所以缓存不能放在默认位置。

- npm、pip、corepack 的缓存在 `/tmp/cache`，由镜像设置。
- 其他要写家目录的工具在沙箱里会失败，需要用该工具自己的环境变量或配置，把缓存指到 worktree 或 `/tmp` 下。
- `/tmp` 是 tmpfs，默认上限 4g。重启容器后缓存清空，依赖以及 pnpm、yarn 会重新下载。
- 镜像没有统一设置 `XDG_CACHE_HOME`，因为 dsh 自己在沙箱外也按它寻找缓存目录。
- 示例：需要编译原生模块的 npm 包会写 `~/.cache/node-gyp`。在仓库的 `.npmrc` 里写 `devdir=/tmp/cache/node-gyp` 可以解决（验证过这个配置能传到安装脚本）；npm 11 会警告这个配置项在下一个大版本不再支持。

#### 检查命令的环境

检查命令是工作流里的 `npm test` 一类命令，由平台在沙箱外、以用户 `eos-check` 运行。它只得到下面这些环境变量：

| 类别 | 变量 |
|---|---|
| 基本 | `PATH`、`LANG`、`LC_ALL`、`TZ`、`TMPDIR`、`CI=1`；`HOME` 是 `/home/eos-check` |
| git | `GIT_CONFIG_COUNT`、`GIT_CONFIG_KEY_0`、`GIT_CONFIG_VALUE_0`（`safe.directory=*`：worktree 属于平台用户，不设时 git 拒绝在其中运行） |
| 证书 | `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR` |
| 代理 | `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 及其小写形式，`NODE_USE_ENV_PROXY` |

- npm 等工具的缓存在 `/home/eos-check` 下，各任务的检查命令共用。
- 传递证书和代理设置，是为了服务器经代理上网时，联网的检查（例如 `npm install`）仍能运行。
- **带账号密码的代理地址（`http://user:pass@...`）不传递。** 检查命令运行的是 agent 改过的代码，可能把账号密码发送出去。此时 `eos doctor` 给出一条 ⚠，联网的检查会失败。
- agent 一侧（dsh 的环境）没有这条限制，得到完整的代理地址，包括其中的账号密码（见「用户和权限」的「限制」）。

### 镜像的依赖探针

镜像里的工具清单在 `docs/deploy.md` 的「镜像里有什么」。

- CI 的依赖探针（`.github/scripts/image-probe.ts`）在构建好的镜像里，以 agent 的用户 `eos-agent`、在断网条件下逐条运行清单里的检查，每条的退出码都必须是 0。
- 探针执行的是 `.github/scripts/image-probe-checks.json`，部署文档里的表是同一份清单的可读版本。`tests/image-probe.test.ts` 核对两者一致。
- 探针使用镜像本身的环境，不经过 dsh。dsh 的环境白名单另有测试，沙箱另有实测记录（见「证据」）。

### 仓库和 worktree 的位置

- 每个任务在 `/data/worktrees/<任务id>` 有自己的 worktree，分支名是 `eos/<任务id>`。
- 填 GitHub 地址时，平台把仓库克隆到 `/data/repos/github.com/<owner>/<repo>.git`，在默认分支的最新提交上建任务分支。
- 平台用凭据克隆仓库、推送任务分支、调用 GitHub 接口开 PR（认证方式见 ADR-007）。凭据加密保存在 `eos.db` 里；git 操作时令牌经环境变量传给平台的 git 进程，不以明文写进数据目录。
- 自行克隆的仓库要以 `eos` 克隆并设 `umask 022`：以 root 克隆时平台写不了；`docker compose exec` 启动的进程 umask 是 0，不设时克隆出的文件人人可写，检查命令也能修改。
- 不把令牌写进这类仓库的 remote URL：agent 能读整个 `/data`。

### 数据、备份和升级

- 备份前先停止容器，是为了保证 SQLite 文件一致。备份和恢复后文件属主保持不变。
- `git-home/` 是空的 HOME：平台访问远程仓库时不读宿主机或镜像里的 git 全局配置。
- 升级只替换容器，不改动数据卷。没有运行完的任务在新容器启动后自动继续，已完成的调用不会重发。
- 数据库没有迁移机制：建表语句都是 `CREATE TABLE IF NOT EXISTS`，没有修改表结构的语句。
- 在服务器上构建时，升级命令的第二行（`docker compose -f compose.yaml build`）只重建基础镜像。使用派生镜像时必须先执行它，否则派生镜像建在旧的基础镜像上；派生镜像沿用 `eos-workbench:local` 标签时会覆盖基础镜像，之后升级拿不到新的 Eos 代码。
- 使用发布的镜像时，`docker compose up --build` 会用本地代码构建并打上 ghcr 的标签，覆盖拉下来的镜像，所以要加 `--no-build`。`compose.override.yaml` 里的 `image:` 会覆盖 `EOS_IMAGE`。
- 访问：使用 4317 以外的本地端口时，浏览器发送的 Host 是 `localhost:<那个端口>`，平台拒绝请求（421）。反向代理没有传递原始 Host 时，写操作被拒绝（403），响应里写明原因。不直接暴露端口的两个原因：平台没有登录；非浏览器客户端可以伪造 Host 绕过检查。

### 证据

正文里的结论对应的实测记录和测试：

| 结论 | 证据 |
|---|---|
| agent 和检查命令读不到主密钥；升级后任务能续接 dsh 会话 | `docs/e2e/deploy-3c-agent-user/` |
| 撤销越界改动用的命令不带能力 | `docs/e2e/deploy-3c-agent-user/without-caps.txt` |
| 迁移被打断时的行为和恢复命令 | `docs/e2e/deploy-3c-agent-user/migration-edge.txt` |
| 沙箱的写入范围；agent 读不到别的进程的环境 | `docs/e2e/deploy-2-image/sandbox/` |
| agent 读不到模型 key | `docs/e2e/deploy-2-image/sandbox/modelkey-probe.json` |
| 三种安装项目依赖的方式在沙箱里可用 | `docs/e2e/deploy-2-image/sandbox/deps-probe.json` |
| 检查命令不能把别的任务的 worktree 改名 | `docs/e2e/deploy-3b-check-user/probe-report.json` 的 `renameWorktreeDir` |
| 平台读不了 dsh 写出的 0600 文件 | `docs/e2e/deploy-3c-agent-user/` 的 `deploy-e2e-1-failed-report.json` |
| doctor 全部为 ✓ 时任务仍可能在第一步失败 | `docs/e2e/deploy-2-image/README.md` |
| 备份和恢复的命令，文件属主保持不变 | `docs/e2e/deploy-2-image/backup-restore.txt` |
| 镜像表和探针清单一致 | `tests/image-probe.test.ts` |
| dsh 的环境白名单 | `tests/agent-env-contract.test.ts` |
