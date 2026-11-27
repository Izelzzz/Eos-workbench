# ADR-006：Docker Compose 部署与容器里的沙箱

- 状态：已采纳（2026-11-24），内容按当前实现维护
- 读者：要理解或修改部署设计的人。安装和维护的步骤在 [`docs/deploy.md`](../deploy.md)
- 关联：ADR-005（凭据存储）、ADR-007（GitHub 授权）。ADR-001 写的「写入隔离依赖 bwrap」在容器里不成立，以本文为准

## 背景

- 平台部署在团队共用的服务器上，agent 在服务端运行，凭据只由平台持有。
- 部署需要包含：镜像、compose、数据持久化，以及 agent 运行任务时的环境。
- dsh 在 Linux 上优先用 bubblewrap（bwrap）做沙箱，bwrap 不可用时退到 Landlock。
- 平台进程的初始环境（`/proc/<pid>/environ`）里始终带着主密钥（ADR-005）。能读到这个环境的进程都能读到主密钥。检查命令在沙箱外运行 agent 写的代码，所以必须让它读不到。

## 目标

1. `docker compose up -d` 即可运行；升级镜像不丢数据。
2. 没有登录时，默认不把平台暴露到网络上。
3. agent 只能写自己任务的 worktree；agent 和检查命令都读不到平台的主密钥和模型 key。
4. 不为了沙箱放宽容器本身的加固。

目标 3 中「agent 读不到模型 key」只在沙箱生效时成立，见「已知限制」。

## 设计

### 总览

容器里的进程、用户和数据。容器去掉了全部能力，只加回 SETUID、SETGID、KILL：

```mermaid
flowchart TB
  browser["浏览器<br/>SSH 隧道或反向代理"] --> port["宿主机 127.0.0.1:4317"]
  port --> plat
  envf[".env<br/>主密钥、模型 key"] --> plat
  subgraph container["容器"]
    plat["平台<br/>用户 eos<br/>带 SETUID、SETGID、KILL"]
    plat -- "切换用户，清掉能力" --> dsh["dsh<br/>用户 eos-agent"]
    plat -- "切换用户，清掉能力" --> chk["检查命令<br/>用户 eos-check"]
    dsh --> agent["agent<br/>Landlock：只能写自己的 worktree 和 /tmp"]
    dsh --> mcp["MCP 服务<br/>沙箱外，用户 eos-agent"]
    plat <--> data[("/data 数据卷<br/>eos.db、dsh、worktrees、repos")]
    agent -- "只能写自己任务的" --> wt["/data/worktrees<br/>各任务的 worktree"]
    chk -- "能写所有任务的 worktree" --> wt
    mcp -- "能写所有任务的 worktree" --> wt
  end
  dsh -- "带模型 key" --> model["模型 API"]
  plat --> gh["GitHub"]
```

| 方面 | 设计 |
|---|---|
| 容器 | 一个容器运行平台、所有任务的 agent 和检查命令 |
| 沙箱 | Docker 默认权限；dsh 用 Landlock 限制 agent 的写入范围 |
| 用户 | 平台、agent、检查命令各用一个系统用户，互相读不到对方进程的环境 |
| 密钥 | 主密钥和模型 key 从宿主机的 `.env` 以环境变量注入，不落盘 |
| 访问 | 容器里监听 `0.0.0.0:4317`，宿主机只绑定 `127.0.0.1:4317` |
| 数据 | 一个命名卷挂到 `/data`；`/tmp` 是 tmpfs |
| 镜像 | 带常用工具链；由 GitHub Actions 发布到 ghcr |

### 沙箱

dsh 用 Landlock 限制 agent。镜像里装了 bwrap，但在 Docker 默认权限下不可用。

**为什么不用 bwrap**

- 在 Docker 默认权限下，bwrap 建不了 user namespace，dsh 自动退到 Landlock。
- 让 bwrap 可用需要两处放宽：放开 seccomp，并去掉 Docker 对 `/proc` 的屏蔽（`systempaths=unconfined`）。
- 去掉 `/proc` 屏蔽后，容器里的 root 能写 `/proc/sysrq-trigger` 等文件。而「用户和权限」的设计要求容器以 root 启动。两者不能同时成立。

**为什么镜像里仍然装 bwrap**

- dsh 先尝试 bwrap，失败只多一次探测。
- 宿主机或编排器放开了 bwrap 需要的权限时，dsh 会自动用上 bwrap，镜像不需要改。

#### 沙箱限制什么

- **写入范围**：agent 只能写自己任务的 worktree 和 `/tmp`，写不了别的任务和数据目录。
- **别的进程的环境**：agent 读不到 dsh 和平台进程的 `/proc/<pid>/environ`，即读不到模型 key 和主密钥。

Landlock 挡住的是对域外进程的 ptrace 类访问。对照：沙箱外同一用户的进程能读到这些环境。

#### 沙箱不限制什么

下表后三行是 Landlock 相对 bwrap 的差别：bwrap 下能写的 agent 有私有的 `/tmp`（只读的 agent 看到的仍是共用的 `/tmp`），并且有单独的进程号空间。

| 不限制的 | 后果 |
|---|---|
| 读文件 | agent 能读整个 `/data`：别的任务和别的成员的 worktree、`/data/repos` 下所有仓库、`eos.db`（所有任务的 trace）、`/data/dsh` 的会话日志。放进这台服务器的仓库和任务，对所有任务的 agent 可见 |
| `/tmp` | 同一容器里的任务共用 `/tmp`，并且都能写。能读到别的任务的临时文件和 dsh 的输出暂存文件（`/tmp/dsh-spill-*`） |
| 共享的依赖缓存 | 一个任务的 agent 放进缓存的内容会被下一个任务使用。npm 按 lockfile 里的 hash 校验包；pip 的缓存和 corepack 下载的 pnpm、yarn 没有这种校验 |
| 进程列表 | agent 能看到进程列表 |

读取这一点上 bwrap 没有区别：它的默认配置也是只读挂载整个根目录。按仓库或按人隔离读权限没有做，它依赖登录和多人（路线图第 7 项）。

#### 模型 key 的保护依赖沙箱生效

这一版 dsh 只能从进程环境里得到模型 key，所以模型 key 在 dsh 进程的环境里。

- 验证过的配置：本镜像、这份 compose、内核 6.18。在这个配置下 Landlock 挡住了 agent 读取 dsh 和平台进程的环境。
- Landlock 没有生效时（内核不支持，或以别的方式运行而没有经过沙箱），同一用户的 agent 能读到模型 key。
- 更换宿主机内核后，重新运行探针确认。探针是 `docs/e2e/deploy-2-image/sandbox/modelkey-probe.mts`，运行方法见同目录 `README.md` 第 4 节。

#### 内核不支持 Landlock 时

- dsh 拒绝执行命令，任务失败，不会在没有限制的状态下运行。
- `eos doctor` 的「沙箱」一项实际探测一次：按 dsh 的参数启动一次 bwrap，实际施加一次 Landlock 规则。两者都不可用时报 ✗。
- doctor 不检查 dsh 本身能否启动。doctor 全部为 ✓ 时，任务仍可能在第一步失败。

较旧的 Landlock ABI 会报告 `partial`。

#### 会被加载的缓存不放在 `/tmp`

agent 能写 `/tmp`。平台和 dsh 会加载的缓存如果放在那里，agent 写入的代码就会在沙箱外运行。因此：

| 缓存 | 处理 |
|---|---|
| tsx 的编译缓存 | 关闭 |
| Node 的字节码缓存 | 关闭 |
| dsh 的 native 模块缓存 | 放在家目录（`NARB_NATIVE_CACHE_DIR`）：平台一份在 `eos` 的家目录，dsh 以 `eos-agent` 运行时改到 `eos-agent` 的家目录 |

例外：检查命令的环境里没有关闭字节码缓存的开关，npm 会在 `/tmp/node-compile-cache` 留下缓存（属于 `eos-check`），之后的检查命令会加载它。检查命令本来就在沙箱外运行 agent 改过的代码，这不会让 agent 获得更多权限。

`/tmp` 挂载为可执行，是因为 agent 运行测试和编译时要执行自己生成的文件。

- 这份清单是按已知的几种缓存列出的。以后的依赖如果再往 `os.tmpdir()` 放会被加载的文件，需要重新检查。
- `TSX_DISABLE_CACHE` 只供平台进程使用，不传给 dsh。

#### MCP 服务的启动方式

**不要用 `npx`、`pnpm dlx`、`uvx`、`pipx run` 这类下载后立即运行的命令启动 MCP 服务。**

- MCP 服务运行在沙箱外，并继承 dsh 的环境，包括指向 `/tmp/cache` 的依赖缓存设置。
- 用这类命令启动时，它可能运行 agent 放进缓存的代码。
- 做法：把 MCP 服务安装进派生镜像（见 `docs/deploy.md` 的「增加系统依赖」），在模板里写它的绝对路径。

### 用户和权限

容器以 root 启动。镜像里的 `eos` 命令（`deploy/eos`）用 `setpriv` 降到平台用户 `eos`，再由平台把 agent 和检查命令切换到各自的用户。

#### 四个用户

| 用户 | 运行什么 | 能读 | 能写 |
|---|---|---|---|
| root | 只有 1 号进程（`docker-init`），以及 `docker compose exec` 不加 `-u` 时的命令 | 只有 `SETUID`、`SETGID`、`KILL` 三个能力，读写不了别的用户的文件 | 同左 |
| `eos` | 平台、git；平台进程自己带着 `SETUID`、`SETGID`、`KILL` | `/data` 全部（dsh 的会话日志以 `eos-agent` 的身份读）、自己进程的环境（主密钥） | `/data` 全部，`/data/dsh` 里 dsh 自己建的 0700 目录除外 |
| `eos-agent` | dsh、agent、dsh 启动的 MCP 服务 | 世界可读的文件、`/data/dsh`、dsh 进程的环境（模型 key；agent 在 Landlock 里读不到）；读不到 `eos` 和 root 进程的环境 | dsh：`/data/dsh`（共用组 `eos-dsh`）、worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；agent 在 Landlock 里只能写自己的 worktree 和 `/tmp` |
| `eos-check` | 检查命令 | 世界可读的文件，包括 `/data` 下大部分（`eos.db`、仓库、worktree）；读不到别的用户进程的环境，进不了 `/data/dsh` | worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；写不了 `eos.db`、`repos/`、`eos` 的家目录 |

**为什么分成三个普通用户**

- 检查命令和 agent 运行的是 agent 写的代码。放在独立用户下，它们读不到平台进程环境里的主密钥。
- 检查命令不和 agent 共用一个用户：同一个 uid 时，检查命令能读到 dsh 进程环境里的模型 key。
- agent 由 dsh 启动，和 dsh 总是同一个用户。要把两者隔开，需要 dsh 不从环境读取模型 key，这一版 dsh 做不到。

**为什么平台是 `eos` 而不是 root**

数据卷里已有的文件都属于 `eos`。root 没有 `CHOWN`、`DAC_OVERRIDE` 能力就写不了它们；让平台以 root 运行，要么多给能力，要么迁移属主。

#### 能力

- compose 去掉全部能力，只加回 `SETUID`、`SETGID`、`KILL`。`no-new-privileges` 保持生效。
- `eos` 命令以 root 启动，降到 `eos` 时保留这三个能力（ambient）。
- 平台用 `SETUID`、`SETGID` 把检查命令切换到 `eos-check`、把 dsh 切换到 `eos-agent`；用 `KILL` 给 dsh 的进程发信号（关闭 dsh），以及结束超时的辅助命令（平台借别的用户身份运行的那些）。
- 切换时清掉全部能力，所以检查命令和 dsh 不能切换回 `eos` 或 root。
- 派生镜像不能加 `USER eos`：容器必须以 root 启动，`eos` 命令才能降到平台用户并保留这三个能力。

**为什么需要 `KILL`**

平台要给 dsh 发信号（关闭 dsh；更换模型 key 后重启 dsh），而 dsh 是另一个用户。另一种做法是以 `eos-agent` 的身份去结束进程，但要修改 vendor 里 SDK 关闭进程的写法。

检查命令的进程不用 `KILL`：超时和中止时，平台以 `eos-check` 的身份运行 `kill` 结束它的进程组。

#### 哪些进程不带能力

规则：平台启动的进程只要会运行仓库代码或第三方程序，就先用 `setpriv` 清掉全部能力。

| 进程 | 启动方式 | 是否带能力 |
|---|---|---|
| dsh、agent、dsh 在沙箱外启动的 MCP 服务 | `deploy/dsh-launch.mjs`：清掉能力并切换到 `eos-agent` | 否 |
| git | `/usr/local/bin/git`（`deploy/git`） | 否 |
| 检查命令 | 切换到 `eos-check` 时清掉能力 | 否 |
| 平台借 `eos-check`、`eos-agent` 的身份运行的辅助命令 | 切换用户时清掉能力 | 否 |
| 撤销越界改动用的 `sh`、`rm`、`find` | 平台启动前清掉能力 | 否 |
| Landlock 探测（启动检查和 `eos doctor` 运行一次 node-addon-system 自带的 `landlock-run`，参数固定） | 由 node-addon-system 包启动，平台加不了前缀 | 是 |
| tsx 的 esbuild 服务进程（编译平台自己的源码） | 由 tsx 在平台进程里启动 | 是 |

仍带能力的两个进程都不接触 worktree，也不运行仓库里的代码。

- 不清掉能力的后果：dsh 在沙箱外启动的 MCP 服务和 git 能切换到 root，改写 `/app`。
- 镜像用环境变量 `EOS_DSH_LAUNCHER` 让平台把启动包装（`deploy/dsh-launch.mjs`）当作 dsh 的入口；`EOS_CHECK_USER`、`EOS_AGENT_USER` 指定两个用户，也由镜像设置。`EOS_AGENT_USER` 在 dsh 的环境白名单里，包装依靠它切换用户。
- dsh 的启动包装是一个 Node 脚本。dsh 由 SDK 以 `node <入口>` 启动，加不了命令前缀，所以脚本用 `process.execve` 把自己替换成 `setpriv`，再替换成 dsh。进程号不变，不多一层进程，平台发的信号和看到的退出码都直接是 dsh 的。
- doctor 的 bwrap 探测也先清掉能力：bwrap 发现自己带着能力又不是 setuid 时会直接退出，清掉后才和 dsh 在同样的条件下探测。
- 新增直接启动子进程的地方，要同样清掉能力（`withoutCaps`）。

#### 目录的归属和权限

| 目录 | 属主、组、权限 | 设计目的 |
|---|---|---|
| `/data/dsh` | `eos`、组 `eos-dsh`、3770（带 sticky 位） | dsh 在里面写会话日志等目录；检查命令不在 `eos-dsh` 组里，进不去 |
| `/data/dsh/eos-profiles/`（能力面）、`/data/dsh/eos-process-cwd/`（dsh 进程的工作目录） | 平台启动时创建，2755 | `eos-agent` 只读。上一级 `/data/dsh` 的 sticky 位使它不能改名或删除这两个目录；平台写入前还核对它们不是符号链接 |
| `/data/dsh/mcp-cwd/` | 属于 `eos-agent` | MCP 服务在里面写缓存和日志；平台不往里写 |
| dsh 创建的会话目录 | 0700，只有 `eos-agent` 能读 | 平台以 `eos-agent` 的身份读取（`src/runner/check-user.ts` 的 `readSessionLogAs`） |
| `/data/worktrees` | 2755，带 setgid，组 `eos-work` | 目录本身组内不可写：检查命令不能把别的任务的 worktree 改名或换成符号链接 |
| 各任务的 worktree | 组 `eos-work`，平台的 umask 是 002 | 检查命令能写 agent 改过的文件 |

- `eos-dsh` 组里只有 `eos` 和 `eos-agent`。
- 不给平台加 `DAC_READ_SEARCH` 来读会话日志：那样平台能读任何文件，范围超过需要。
- 平台写入 `eos-profiles/`、`eos-process-cwd/` 前的核对在 `platformDir`：是真实的目录、不是符号链接、属主是平台自己。没有这层保护时，`eos-agent`（例如 dsh 启动的 MCP 服务）能把目录换成符号链接，使平台顺着链接覆盖 `eos.db`。

#### 平台如何处理别的用户留下的进程和文件

平台读不到别的用户进程的工作目录，也可能读不了它们创建的文件，所以在两个时点借用它们的身份操作。

| 时点 | 平台做什么 | 原因 |
|---|---|---|
| 撤销越界改动之前 | 以 `eos-check`、`eos-agent` 的身份找出并结束它们留在 worktree 里的进程 | 平台自己看不到这些进程的工作目录 |
| 提交、撤销越界改动之前，以及检查命令结束之后 | 以 `eos-agent`、`eos-check` 的身份把它们在 worktree 里创建的文件改回 worktree 的组，并开放组读写 | dsh 写文件时经过一个 `chmod 0700` 的临时目录，文件落在 `eos-agent` 自己的组里、权限 0600，平台读不了 |

- 平台读不到别的用户进程的工作目录，是因为这需要 `SYS_PTRACE` 能力。
- 改组和开放组读写由 `shareWithGroup` 完成。在这一步之后、下一次提交之前新建的文件不在处理范围内，例如检查命令结束后仍在运行的后台进程写的文件。
- 撤销越界改动时不跟随符号链接：先进入要删除的路径的上一级目录，用 `pwd -P` 核对仍在 worktree 内，再按相对路径 `rm -rf -- <名字>`。测试在 `tests/write-scope.test.ts`。

#### 从旧版本升级

适用于 dsh 以 `eos` 运行的旧版本（`/data/dsh` 里的文件属于 `eos`）。

**自动迁移。** 新版本第一次启动平台（`eos web`）时：

1. 以 `eos-agent` 的身份把 `/data/dsh` 复制到 `/data/dsh.agent-new`。复制前把旧目录的组改为 `eos-dsh` 并开放组读，所以备份目录的组和权限和迁移前不同。不复制 `.credentials.yaml`：它是 dsh 自己的浏览器会话授权，里面没有模型 key；dsh 要求它只有属主可读（组内可读时 dsh 拒绝启动），所以也不改它的权限，由 dsh 重新生成。
2. 把旧目录 `/data/dsh` 改名为 `/data/dsh.before-agent`。这个名字已被占用时改名为 `/data/dsh.before-agent-<时间戳>`。
3. 把 `/data/dsh.agent-new` 改名为 `/data/dsh`。
4. 写标记文件 `/data/.dsh-agent`。

进行中的任务能续接原来的 dsh 会话。确认任务正常后可以删除备份目录。

**迁移被打断。** 在第 2 步和第 3 步之间被打断时，`/data/dsh` 不存在而 `/data/dsh.agent-new` 存在。此时除 `eos doctor` 外，`eos` 的命令（启动平台、`run`、`resume` 等）都不运行并给出提示。手工恢复：

```bash
docker compose run --rm -u eos eos mv /data/dsh.agent-new /data/dsh
docker compose up -d
```

**worktree 的组。** 升级前创建的 worktree 在第一次启动时改为 `eos-work` 组。`/data/.worktrees-group` 是已完成的标记。

**不再使用的旧目录。** 升级后遗留的 `/data/dsh/profiles/<指纹>/`、`/data/dsh/process-cwd/` 不再使用，可以删除。它们属于 `eos-agent`，所以以 `eos-agent` 的身份删除。命令见 `docs/deploy.md` 的「从旧版本升级后的清理」。

**为什么用复制而不是改属主**

旧的 `/data/dsh` 属于 `eos`，其中 dsh 的文件多为 0700、0600，`eos-agent` 用不了；平台没有 `CHOWN` 能力，改不了属主。

**其他规则**

- 迁移不复制平台自己的 `eos-*` 目录，复制完成后重新创建。
- 迁移停在中间时平台不启动，避免下一次迁移删掉已经复制好的数据。

### 主密钥和模型 key

- 主密钥只能是环境变量 `EOS_MASTER_KEY`（ADR-005），不写进容器的文件系统。compose 从同目录的 `.env` 读取。
- 不用 compose 的 `secrets`：它会把密钥挂成容器里的文件，agent 能读文件系统。
- 能使用 docker 的宿主机用户可以用 `docker inspect` 或 `docker compose config` 看到主密钥。

#### 模型 key 的来源

- 平台先读凭据存储里名为 `deepseek` 的凭据，没有时才读 `.env` 里的 `DEEPSEEK_API_KEY`。第一次启动只能依靠 `.env`。
- 启动后可以在 Web 的凭据页添加 `deepseek`，再从 `.env` 删掉这一行并执行 `docker compose up -d`。
- 两处都没有时平台不启动，compose 会不断重启容器，`docker compose exec` 不可用。查看原因用 `docker compose logs eos` 或 `docker compose run --rm eos eos doctor`。

### 启动检查：`eos doctor` 在这份 compose 下的结果

| 检查项 | 预期结果 | 失败时 |
|---|---|---|
| 沙箱 | Landlock。镜像里装了 bwrap，但在 Docker 默认权限下不可用 | bwrap 和 Landlock 都不可用时为 ✗，平台不启动 |
| 检查命令的用户 | 实际切换一次到 `eos-check` 并成功 | 切换失败时为 ✗，平台不启动；不会退回到用平台用户运行检查命令。平台不以 root 启动时（例如派生镜像加了 `USER eos`）会这样：`eos` 命令跳过降权，平台没有切换用户的能力。compose 里去掉 `cap_add` 时走不到 doctor：`eos` 命令降权失败，直接退出 |
| agent 的用户 | 实际切换一次到 `eos-agent` 并成功；要求设置了 `EOS_DSH_LAUNCHER`、平台有 `KILL` 能力 | 不满足时为 ✗，平台不启动 |
| 检查命令的代理 | 代理地址不带账号密码 | 带账号密码时为 ⚠，这个地址不传给检查命令 |
| 凭据隔离 | ✓：检查命令读不到主密钥和模型 key；agent 读不到主密钥，读不到模型 key 只依赖沙箱 | — |

### 访问

- compose 把端口绑定到宿主机的 `127.0.0.1:4317`。团队成员用 SSH 隧道访问；用域名访问时放在带认证的反向代理后面，并设置 `EOS_PUBLIC_URL`。
- 没有登录，能打开这个地址的人权限相同。不绑定 `0.0.0.0` 的原因有两个：平台没有登录；非浏览器客户端可以伪造 Host 绕过检查。
- 使用 4317 以外的本地端口时，浏览器发送的 Host 是 `localhost:<那个端口>`，平台拒绝请求（421）。
- 反向代理没有传递原始 Host 时，写操作被拒绝（403），响应里写明原因。

### 执行器环境

- 镜像里有 git、Node 24 和 npm、corepack（pnpm、yarn）、Python 3（含 venv、pip）、build-essential、pkg-config。完整清单在 `docs/deploy.md` 的「镜像里有什么」。
- 镜像带 Python 3 和编译工具链，是因为很多仓库的测试离不开它们。
- agent 不是 root，在 Landlock 下只能写 worktree 和 `/tmp`，所以运行任务时装不了系统包。项目自己的依赖装在 worktree 里；需要别的系统依赖时用派生镜像。
- agent 访问网络不受限制，安装依赖需要联网。

#### 缓存位置

家目录在沙箱里不可写，所以缓存不能放在默认位置。

- npm、pip、corepack 的缓存在 `/tmp/cache`，由镜像设置。
- 其他要写家目录的工具在沙箱里会失败，需要用该工具自己的环境变量或配置，把缓存指到 worktree 或 `/tmp` 下。
- `/tmp` 是 tmpfs，默认上限 4g。重启容器后缓存清空，依赖以及 pnpm、yarn 会重新下载。
- 镜像没有统一设置 `XDG_CACHE_HOME`，因为 dsh 自己在沙箱外也按它寻找缓存目录。
- 示例：需要编译原生模块的 npm 包会写 `~/.cache/node-gyp`。在仓库的 `.npmrc` 里写 `devdir=/tmp/cache/node-gyp` 可以解决（验证过这个配置能传到安装脚本）；npm 11 会警告这个配置项在下一个大版本不再支持。

dsh 和 agent 用到的 5 个变量（`NARB_NATIVE_CACHE_DIR`、`NODE_DISABLE_COMPILE_CACHE`、`npm_config_cache`、`PIP_CACHE_DIR`、`COREPACK_HOME`）在 dsh 的环境白名单（`AGENT_ENV_KEEP`）里按名字放行，否则到不了 dsh 和 agent。

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
- agent 一侧（dsh 的环境）没有这条限制，得到完整的代理地址，包括其中的账号密码（见「已知限制」）。

#### 平台目录里没有 typescript

平台自己的 `/app` 不带 typescript：它只是用于类型检查的开发依赖，其编译器二进制有漏洞。

- 在容器的 `/app` 下执行 `npm run typecheck` 会报 `tsc: not found`。类型检查在 CI 和开发机上进行。
- 任务仓库自己的 typescript 照常安装在 worktree 里，不受影响。

#### 依赖探针

镜像里的工具清单在 `docs/deploy.md` 的「镜像里有什么」。

- CI 的依赖探针（`.github/scripts/image-probe.ts`）在构建好的镜像里，以 agent 的用户 `eos-agent`、在断网条件下逐条运行清单里的检查，每条的退出码都必须是 0。
- 探针执行的是 `.github/scripts/image-probe-checks.json`，部署文档里的表是同一份清单的可读版本。`tests/image-probe.test.ts` 核对两者一致。
- 探针还核对三个用户的 uid、组，以及 `/data` 的属主。
- 探针使用镜像本身的环境，不经过 dsh。dsh 的环境白名单另有测试，沙箱另有实测记录（见「证据」）。

### 仓库和 worktree

- 每个任务在 `/data/worktrees/<任务id>` 有自己的 worktree，分支名是 `eos/<任务id>`。
- 填 GitHub 地址时，平台把仓库克隆到 `/data/repos/github.com/<owner>/<repo>.git`，在默认分支的最新提交上建任务分支。
- 平台用凭据克隆仓库、推送任务分支、调用 GitHub 接口开 PR（认证方式见 ADR-007）。凭据加密保存在 `eos.db` 里；git 操作时令牌经环境变量传给平台的 git 进程，不以明文写进数据目录。
- 自行克隆的仓库要以 `eos` 克隆并设 `umask 022`：以 root 克隆时平台写不了；`docker compose exec` 启动的进程 umask 是 0，不设时克隆出的文件人人可写，检查命令也能修改。
- 不把令牌写进这类仓库的 remote URL：agent 能读整个 `/data`。

### 数据、备份和升级

- `/data` 里有 `eos.db`、`dsh/`、`worktrees/`、`repos/`、`git-home/`、`logs/`、`locks/`。
- `/tmp` 是 tmpfs，不进数据卷，上限 4g。它挂载为可执行，因为 agent 运行测试和编译时要执行自己生成的文件。

- 备份前先停止容器，是为了保证 SQLite 文件一致。备份和恢复后文件属主保持不变。
- `git-home/` 是空的 HOME：平台访问远程仓库时不读宿主机或镜像里的 git 全局配置。
- 升级只替换容器，不改动数据卷。没有运行完的任务在新容器启动后自动继续，已完成的调用不会重发。
- 数据库没有迁移机制：建表语句都是 `CREATE TABLE IF NOT EXISTS`，没有修改表结构的语句。
- 在服务器上构建时，升级命令的第二行（`docker compose -f compose.yaml build`）只重建基础镜像。使用派生镜像时必须先执行它，否则派生镜像建在旧的基础镜像上；派生镜像沿用 `eos-workbench:local` 标签时会覆盖基础镜像，之后升级拿不到新的 Eos 代码。
- 使用发布的镜像时，`docker compose up --build` 会用本地代码构建并打上 ghcr 的标签，覆盖拉下来的镜像，所以要加 `--no-build`。`compose.override.yaml` 里的 `image:` 会覆盖 `EOS_IMAGE`。

### 镜像发布

GitHub Actions 把镜像发布到 ghcr（`.github/workflows/image.yml`）。目的是让服务器直接拉取镜像，不必各自构建约 2.6GB 的镜像、访问 npm 和 apt 源；并且能指定版本、能回退。

| 方面 | 设计 |
|---|---|
| 镜像名 | `ghcr.io/izelzzz/eos-workbench`，和仓库同名，公开，拉取不需要登录。镜像里没有密钥，key 在运行时从 `.env` 传入 |
| 标签 | `v*` 标签发布版本号，正式版同时发布 `latest`；合并到 main 发布 `main` 和 `sha-<短提交号>` |
| PR | PR 按同样的步骤构建、冒烟、运行依赖探针、扫描漏洞，不登录、不推送。只有纯文档的 PR 跳过；其余不按路径筛选，因为镜像里有 `src/`、`web/` 的构建，按路径筛选会漏掉弄坏镜像的改动 |
| 发布门槛 | 推送前依次通过：冒烟、依赖探针（`image-probe.ts`）、漏洞扫描（Trivy，`image-scan.sh`）。存在已有修复版本的 HIGH 或 CRITICAL 漏洞时不发布，豁免写在 `.trivyignore.yaml` |
| compose | `compose.yaml` 默认仍在本地构建；使用发布的镜像时在 `.env` 里设置 `EOS_IMAGE` |
| 权限 | 用 `GITHUB_TOKEN` 推送，不引入第三方 action（只用 GitHub 官方的 `checkout`、`setup-node`，按提交号锁定；Trivy 用按 digest 锁定的镜像）。有写包权限的只有发布的 job，PR 的 job 只读 |
| 冒烟 | 推送前运行一次 `eos --help`，使用和 compose 相同的能力：验证镜像能启动、启动包装能降到 `eos` 用户 |

- 标签由 `.github/scripts/image-tags.ts` 计算（有单元测试）。构建和冒烟在 `.github/scripts/image-build.sh`，PR 和发布共用。
- main 上每个提交单独一组并发，连续合并不会跳过中间提交的 `sha-` 标签。
- 几次发布可能并行。浮动标签 `main` 在推送前核对 main 分支仍指向本提交（`.github/scripts/image-push.sh`）。
- 包第一次发布后，要由仓库所有者在 GitHub 的包设置里改成公开一次，工作流做不到。

## 没有采用的方案

| 方案 | 不采用的原因 |
|---|---|
| 放开 seccomp 和 `/proc` 屏蔽，用 bwrap，平台不用 root、不分用户 | 检查命令和平台是同一个用户，能读到主密钥。不满足目标 3 |
| bwrap + 独立用户 + 平台以 root 启动 | 容器里的 root 加上去掉 `/proc` 屏蔽，能改宿主机内核参数 |
| `--privileged` | 等于不隔离 |
| 主密钥放在文件里，用 compose `secrets` 挂进容器 | 文件在磁盘上，agent 的沙箱能读到（ADR-005） |
| 精简镜像，只放 git 和 Node | 很多仓库的测试需要 Python 3 和编译工具链 |
| 给平台加 `DAC_READ_SEARCH` 来读 dsh 的会话日志 | 平台能读任何文件，范围超过需要 |
| 以 `eos-agent` 的身份结束 dsh，而不是给平台 `KILL` | 要修改 vendor 里 SDK 关闭进程的写法 |

## 已知限制

| 限制 | 说明 |
|---|---|
| 模型 key 对 agent 只依赖沙箱 | agent 和 dsh 是同一个用户。dsh 在沙箱外启动的 MCP 服务读得到模型 key |
| 带账号密码的代理地址会进入 agent 的环境 | 检查命令一侧已经不传，agent 一侧没有这条限制 |
| 平台进程自己能切换到任何用户，包括 root | root 只有三个能力，但拥有 `/app` 等文件。平台进程本身可信；它启动的会运行外部代码的进程都清掉了能力 |
| 检查命令能读世界可读的文件 | 包括 `eos.db`（trace、加密的凭据）、所有仓库和 worktree。它写不了这些文件，也读不到主密钥，所以解不开凭据 |
| 一个任务的检查命令能改别的任务的 worktree | 见下文 |
| agent 能读整个 `/data` | Landlock 只限制写。见「沙箱不限制什么」 |
| 任务共用 `/tmp` 和依赖缓存 | 任务之间可以互相读临时文件、污染缓存。见「沙箱不限制什么」 |
| 宿主机内核必须支持 Landlock | Linux 5.13 以上并启用 landlock。不支持时任务失败，不会不受限制地运行 |
| 没有登录 | 网络上能连到端口的人都能使用。默认只绑定 `127.0.0.1` |
| 镜像约 2.6GB | 其中 dsh 的依赖约 930MB，编译工具链和 Python 约几百 MB |

**一个任务的检查命令能改别的任务的 worktree**

- 所有任务的 worktree 都归组 `eos-work`，所有任务的检查命令都是同一个用户 `eos-check`。
- 后果是完整性问题：任务 A 的仓库里的恶意依赖可以往任务 B 的 worktree 里写内容，随后被平台提交进 B 的分支。
- agent 在 Landlock 里写不了别的 worktree，但 dsh 在沙箱外启动的 MCP 服务可以。
- 按任务分组或加 ACL 解决不了，因为所有任务用的是同一个 `eos-check`、`eos-agent`。
- 可行的方向有两个：把检查命令也放进 Landlock（只能写自己的 worktree、家目录和 `/tmp`）；或者按任务分配用户。两者都没有做。

**共享缓存的根本解法**

按任务分开缓存，并且不让沙箱外的进程使用 agent 可写的缓存。没有做。

## 涉及的文件

| 范围 | 文件 |
|---|---|
| 镜像和 compose | `Dockerfile`、`.dockerignore`、`compose.yaml` |
| 启动和降权 | `deploy/eos`（降权入口，准备和迁移 `/data/dsh`）、`deploy/dsh-launch.mjs`（清掉能力并切换到 `eos-agent`）、`deploy/git`（清掉能力） |
| 平台代码 | `src/cli.ts`、`src/runner/check-user.ts`、`src/runner/checks.ts`、`src/runner/doctor.ts`、`src/runner/git.ts`（清掉能力、撤销时核对路径）、`src/runner/supervisor.ts`、`src/runner/runner.ts`、`src/runner/mirror.ts`、`src/executor/dsh.ts`、`src/credentials/model-key.ts` |
| 镜像发布 | `.github/workflows/image.yml`、`.github/scripts/` 下的 `image-tags.ts`、`image-build.sh`、`image-push.sh`、`image-probe.ts`、`image-probe-checks.json`、`image-scan.sh`，以及 `.trivyignore.yaml` |
| 文档和验证 | `docs/deploy.md`、`scripts/deploy-e2e.ts` |

不在容器里运行、没有设置 `EOS_CHECK_USER` 和 `EOS_AGENT_USER` 时：检查命令和 agent 都以平台的用户运行；检查命令的环境仍是同一份白名单加 `CI=1`，但不更换 `HOME`，不设置 `safe.directory`。

## 证据

结论对应的实测记录和测试：

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
| doctor 报告实际使用的沙箱 | `docs/e2e/deploy-3a-doctor/` |
| 检查命令读不到 `eos` 和 root 进程的环境，切换不回 `eos` 或 root | `docs/e2e/deploy-3b-check-user/` |
