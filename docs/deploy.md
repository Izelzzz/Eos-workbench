# 用 Docker Compose 部署 Eos

本文说明怎样在一台服务器上用 Docker Compose 部署 Eos，以及部署后的运行环境、权限和数据。适用于一个小团队共用一台服务器。设计取舍见 [ADR-006](adr/006-docker-deployment.md)。

## 部署前须知

| 事项 | 现状 | 部署方要做的 |
|---|---|---|
| 登录 | 没有登录。能打开 Eos 地址的人都能建任务、看所有 trace、在服务器的仓库上运行 agent | 保持默认的 `127.0.0.1` 绑定，或放在带认证的反向代理后面（见「访问」） |
| 主密钥 | 只在平台进程的环境里，agent 和检查命令都读不到 | 另外备份一份；丢失后存过的凭据只能重新录入 |
| 模型 key | 在 dsh 进程的环境里。检查命令读不到；agent 读不到它只依赖沙箱；dsh 在沙箱外启动的 MCP 服务读得到 | 使用额度受限的模型 key |
| 任务之间的隔离 | 没有。agent 能读整个 `/data`，包括别的任务的 worktree、所有仓库和所有 trace | 只放入对全体使用者都可见的仓库 |
| 出网 | agent 和检查命令访问网络不受限制 | 需要限制时在宿主机或 Docker 网络一层配置 |

宿主机要求：

- Docker Engine 和 Compose v2。
- 内核支持 Landlock：Linux 5.13 以上，并且 `cat /sys/kernel/security/lsm` 的输出里有 `landlock`。原因见「沙箱」。
- 能使用 docker 的宿主机用户可以用 `docker inspect` 或 `docker compose config` 看到主密钥，所以 docker 组的成员必须可信。

## 启动

### 步骤

1. 克隆仓库。

   ```bash
   git clone https://github.com/Izelzzz/Eos-workbench.git && cd Eos-workbench
   ```

2. 在同一目录创建 `.env`，权限只给自己。这个文件不提交。

   ```bash
   umask 077
   cat > .env <<EOF
   DEEPSEEK_API_KEY=<你的 key>
   EOS_MASTER_KEY=$(openssl rand -base64 32)
   EOF
   ```

3. 构建并启动。

   ```bash
   docker compose up -d --build
   ```

4. 检查运行环境。

   ```bash
   docker compose exec eos eos doctor
   ```

### 镜像里的 `eos` 命令

- `eos` 是平台的命令行，例如 `eos web`、`eos doctor`。
- 容器以 root 启动，`eos` 先降到平台用户 `eos` 再运行（见「用户和权限」）。
- 在容器里运行别的命令时加 `-u eos`，例如 `docker compose exec -u eos eos git ...`。

### 模型 key

- 平台先读凭据存储里名为 `deepseek` 的凭据，没有时才读 `.env` 里的 `DEEPSEEK_API_KEY`。第一次启动只能依靠 `.env`。
- 启动后可以在 Web 的凭据页添加 `deepseek`，再从 `.env` 删掉这一行并执行 `docker compose up -d`。
- 两处都没有时平台不启动，compose 会不断重启容器，`docker compose exec` 不可用。查看原因用 `docker compose logs eos` 或 `docker compose run --rm eos eos doctor`。

### 主密钥

- `EOS_MASTER_KEY` 是凭据存储的主密钥（ADR-005）。
- 它只以环境变量的形式进入容器，不写进容器的文件系统。

### `eos doctor` 在这份 compose 下的结果

| 检查项 | 预期结果 | 失败时 |
|---|---|---|
| 沙箱 | Landlock。镜像里装了 bwrap，但在 Docker 默认权限下不可用 | bwrap 和 Landlock 都不可用时为 ✗，平台不启动 |
| 检查命令的用户 | 实际切换一次到 `eos-check` 并成功 | 切换失败（例如 compose 里去掉了 `cap_add`）时为 ✗，平台不启动；不会退回到用平台用户运行检查命令 |
| 凭据隔离 | ✓：检查命令读不到主密钥和模型 key；agent 读不到主密钥，读不到模型 key 只依赖沙箱 | — |

## 用发布的镜像

GitHub Actions 把镜像发布到 ghcr（`.github/workflows/image.yml`）。拉取不需要登录。

### 标签

| 标签 | 更新时机 |
|---|---|
| `ghcr.io/izelzzz/eos-workbench:<版本号>` | 推送 `v<版本号>` 标签时。例如 `v0.1.0` 发布 `0.1.0` |
| `ghcr.io/izelzzz/eos-workbench:latest` | 最近一次推送的正式版标签（版本号里没有 `-`）。给旧版本补发修订版时它也会指向那个修订版；一次推送多个正式版标签时，指向哪一个不确定 |
| `ghcr.io/izelzzz/eos-workbench:main` | 每次合并到 main。连续合并时只有最新的提交会推送；构建失败时不更新，停在上一个成功的提交 |
| `ghcr.io/izelzzz/eos-workbench:sha-<短提交号>` | 每次合并到 main。不会被覆盖 |

### 使用

仍然需要克隆仓库，因为要用其中的 `compose.yaml`。在 `.env` 里指定镜像：

```bash
echo 'EOS_IMAGE=ghcr.io/izelzzz/eos-workbench:0.1.0' >> .env
docker compose pull
docker compose up -d --no-build
```

- **写具体的版本号或 `sha-` 标签**，不写 `latest`、`main`。这样升级时机由部署方决定，回退时目标明确。
- **必须加 `--no-build`**。不加时 `docker compose up --build` 会用本地代码构建，打上 ghcr 的标签，覆盖拉下来的镜像。
- **仓库代码和镜像版本保持一致**（`git checkout v0.1.0`）。`compose.yaml` 里的能力、tmpfs 等设置随镜像一起变化。

### 和派生镜像一起用

使用派生镜像（见「增加系统依赖」）时，`compose.override.yaml` 里的 `image:` 会覆盖 `EOS_IMAGE`，`EOS_IMAGE` 不起作用。做法：

1. 把 `Dockerfile.team` 的 `FROM` 改成发布的标签，例如 `FROM ghcr.io/izelzzz/eos-workbench:0.1.0`。
2. 执行 `docker compose build --pull && docker compose up -d`。

### 升级和回退

| 操作 | 不用派生镜像 | 用派生镜像 |
|---|---|---|
| 升级 | 改 `.env` 里的 `EOS_IMAGE`，执行 `docker compose pull && docker compose up -d --no-build` | 改 `Dockerfile.team` 的 `FROM`，执行 `docker compose build --pull && docker compose up -d` |
| 回退 | 把 `EOS_IMAGE` 改回原标签，执行同样的命令 | 把 `FROM` 改回原标签，执行同样的命令 |

- 升级前先备份（见「备份」）。
- 升级和回退都不改动数据卷。
- 升级后数据如果已被新版本修改（例如 dsh 目录的迁移），回退前先恢复升级前的备份。

## 访问

平台在容器里监听 `0.0.0.0:4317`，compose 只把它映射到服务器的 `127.0.0.1:4317`。

### SSH 隧道（默认）

在自己的电脑上执行下面的命令，然后打开 http://localhost:4317 。

```bash
ssh -N -L 4317:127.0.0.1:4317 <服务器>
```

本地端口必须是 4317。使用别的本地端口时，浏览器发送的 Host 是 `localhost:<那个端口>`，平台会拒绝请求（421）。此时把 `.env` 里的 `EOS_PUBLIC_URL` 设为 `http://localhost:<那个端口>`。

### 反向代理（用域名访问）

代理负责 HTTPS 和认证（例如 SSO 或 basic auth），转发到服务器的 `127.0.0.1:4317`。

1. 在 `.env` 里设置外部地址。

   ```
   EOS_PUBLIC_URL=https://eos.example.com
   ```

2. 代理必须传递原始 Host。nginx 的配置：

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:4317;
     proxy_set_header Host $http_host;
   }
   ```

没有传递原始 Host 时，页面能打开，但所有写操作被拒绝（403），响应里写明原因。

### 不要直接暴露端口

不要把 compose 的端口改成 `0.0.0.0:4317` 或 `4317:4317`。原因有两个：

- 整个网络都能访问一个没有登录的平台。
- 非浏览器客户端可以伪造 Host，绕过平台的 Host 检查。

## 仓库放在哪里

每个任务在 `/data/worktrees/<任务id>` 有自己的 worktree，分支名是 `eos/<任务id>`。新建任务时「仓库」一栏有两种填法。

### GitHub 地址

填 `https://github.com/<owner>/<repo>`。

- 平台把仓库克隆到 `/data/repos/github.com/<owner>/<repo>.git`，在默认分支的最新提交上建任务分支。
- 访问私有仓库需要凭据，并且需要设置 `EOS_MASTER_KEY`。可以在 Web 的凭据页添加名为 `github.com` 的 Git 令牌；GitHub App 和用户授权见 [ADR-007](adr/007-github-user-authorization.md)。
- 令牌只由平台的 git 进程使用，不写进数据目录。

### 容器里的路径

先自行把仓库克隆进容器。建议放在 `/data/repos/local/` 下，和平台维护的镜像分开。

```bash
docker compose exec -u eos eos sh -c 'umask 022 && git clone https://github.com/<组织>/<仓库>.git /data/repos/local/<仓库>'
```

| 参数 | 作用 |
|---|---|
| `-u eos` | 以平台用户克隆。以 root 克隆时平台写不了这个仓库 |
| `umask 022` | `docker compose exec` 启动的进程 umask 是 0；不设时克隆出的文件人人可写，检查命令也能修改 |

不要把令牌写进这类仓库的 remote URL：agent 能读整个 `/data`（见「沙箱」）。

## 执行器环境

agent 运行任务时的环境就是这个镜像。

### 镜像里有什么

| 内容 | 版本 | 检查 |
|---|---|---|
| 系统 | Ubuntu 24.04 | `grep -qx 'VERSION_ID="24.04"' /etc/os-release` |
| Node、npm | Node 24（见 `Dockerfile` 第一行）；npm 换成了修过漏洞的版本（`Dockerfile` 里的 `NPM_VERSION`） | `node --version \| grep -q '^v24\.'`、`npm --version` |
| pnpm、yarn | 通过 corepack，按仓库 `package.json` 的 `packageManager` 字段取版本。镜像里没有预装，第一次用时联网下载 | `corepack --version`、`command -v pnpm`、`command -v yarn` |
| Python | 3.12，带 venv 和 pip | `python3 --version \| grep -q '^Python 3\.12\.'`、`python3 -m pip --version`、`python3 -m venv /tmp/probe-venv && /tmp/probe-venv/bin/python -m pip --version` |
| 编译 | build-essential（gcc、make）、pkg-config | `printf '#include <stdio.h>\nint main(void){return puts("ok") < 0;}\n' \| gcc -x c - -o /tmp/probe-c && /tmp/probe-c`、`printf '#include <vector>\nint main(){return std::vector<int>{0}[0];}\n' \| g++ -x c++ - -o /tmp/probe-cxx && /tmp/probe-cxx`、`make --version`、`pkg-config --version` |
| 其他 | git、ca-certificates、bubblewrap | `git --version`、`test -s /etc/ssl/certs/ca-certificates.crt`、`bwrap --version` |

「检查」一列是 CI 的依赖探针（`.github/scripts/image-probe.ts`）运行的命令。

- 探针在构建好的镜像里，以 agent 的用户 `eos-agent`、在断网条件下逐条运行，每条的退出码都必须是 0。
- 探针执行的是 `.github/scripts/image-probe-checks.json`，这张表是同一份清单的可读版本。`tests/image-probe.test.ts` 核对两者一致，修改检查时两处同时修改。
- 探针使用镜像本身的环境，不经过 dsh。dsh 的环境白名单和沙箱另有测试（`tests/agent-env-contract.test.ts`）。

### 平台目录里没有 typescript

平台自己的 `/app` 不带 typescript：它只是用于类型检查的开发依赖，其编译器二进制有漏洞。

- 在容器的 `/app` 下执行 `npm run typecheck` 会报 `tsc: not found`。类型检查在 CI 和开发机上进行。
- 任务仓库自己的 typescript 照常安装在 worktree 里，不受影响。

### 项目依赖

agent 以普通用户运行，只能写自己任务的 worktree 和 `/tmp`，因此**运行任务时不能安装系统包**（`apt-get` 会失败）。

项目自己的依赖安装在 worktree 里。以下三种方式在沙箱里验证过：

- `npm install`
- `pnpm install`
- `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`

### 缓存位置

| 缓存 | 位置 | 说明 |
|---|---|---|
| npm、pip、corepack | `/tmp/cache` | 家目录在沙箱里不可写 |
| 其他要写家目录的工具 | 需要用该工具自己的环境变量或配置指到 worktree 或 `/tmp` 下 | 否则在沙箱里失败 |

- `/tmp` 是 tmpfs，默认上限 4g。重启容器后缓存清空，依赖以及 pnpm、yarn 会重新下载。
- 镜像没有统一设置 `XDG_CACHE_HOME`，因为 dsh 自己在沙箱外也按它寻找缓存目录。
- 示例：需要编译原生模块的 npm 包会写 `~/.cache/node-gyp`。在仓库的 `.npmrc` 里写 `devdir=/tmp/cache/node-gyp` 可以解决；npm 11 会警告这个配置项在下一个大版本不再支持。

### 增加系统依赖

需要镜像里没有的系统依赖（特定版本的 Python、Go、Java、系统库）时，使用派生镜像。

1. 编写基于 Eos 镜像的 Dockerfile，例如 `Dockerfile.team`。

   ```dockerfile
   FROM eos-workbench:local
   RUN apt-get update && apt-get install -y --no-install-recommends golang-go libpq-dev && rm -rf /var/lib/apt/lists/*
   ```

2. 编写 `compose.override.yaml`（compose 自动读取），给派生镜像一个不同的标签。

   ```yaml
   services:
     eos:
       build: { context: ., dockerfile: Dockerfile.team }
       image: eos-workbench:team
   ```

两条约束：

- **不要加 `USER eos`。** 容器必须以 root 启动，`eos` 命令才能降到平台用户并保留切换用户所需的能力（见「用户和权限」）。
- **派生镜像不能沿用 `eos-workbench:local` 这个标签。** 沿用时它会覆盖基础镜像，之后升级拿不到新的 Eos 代码。

第一次部署和每次升级都要先构建基础镜像，再构建派生镜像（见「升级」）。

### 网络

- agent 访问网络不受限制，安装依赖需要联网。
- 需要限制出网时，在宿主机或 Docker 网络一层配置。

### 检查命令的环境

检查命令是工作流里的 `npm test` 一类命令，由平台在沙箱外、以用户 `eos-check` 运行。它只得到下面这些环境变量：

| 类别 | 变量 |
|---|---|
| 基本 | `PATH`、语言和时区、`CI=1`；`HOME` 是 `/home/eos-check` |
| 证书 | `NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR` |
| 代理 | `HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 及其小写形式，`NODE_USE_ENV_PROXY` |

- npm 等工具的缓存在 `/home/eos-check` 下，各任务的检查命令共用。
- 传递证书和代理设置，是为了服务器经代理上网时，联网的检查（例如 `npm install`）仍能运行。
- **带账号密码的代理地址（`http://user:pass@...`）不传递。** 检查命令运行的是 agent 改过的代码，可能把账号密码发送出去。此时 `eos doctor` 给出一条 ⚠，联网的检查会失败。
- agent 一侧（dsh 的环境）没有这条限制，得到完整的代理地址。

## 用户和权限

### 四个用户

| 用户 | 运行什么 | 能读 | 能写 |
|---|---|---|---|
| root | 只有 1 号进程（`docker-init`），以及 `docker compose exec` 不加 `-u` 时的命令 | 只有 `SETUID`、`SETGID`、`KILL` 三个能力，读写不了别的用户的文件 | 同左 |
| `eos` | 平台、git；平台进程自己带着 `SETUID`、`SETGID`、`KILL` | `/data` 全部（dsh 的会话日志以 `eos-agent` 的身份读）、自己进程的环境（主密钥） | `/data` 全部，`/data/dsh` 里 dsh 自己建的 0700 目录除外 |
| `eos-agent` | dsh、agent、dsh 启动的 MCP 服务 | 世界可读的文件、`/data/dsh`、dsh 进程的环境（模型 key；agent 在 Landlock 里读不到）；读不到 `eos` 和 root 进程的环境 | dsh：`/data/dsh`（共用组 `eos-dsh`）、worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；agent 在 Landlock 里只能写自己的 worktree 和 `/tmp` |
| `eos-check` | 检查命令 | 世界可读的文件，包括 `/data` 下大部分（`eos.db`、仓库、worktree）；读不到别的用户进程的环境，进不了 `/data/dsh` | worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；写不了 `eos.db`、`repos/`、`eos` 的家目录 |

把检查命令和 agent 放在独立用户下的目的：它们运行的是 agent 写的代码，不能读到平台进程环境里的主密钥。

### 能力

- compose 去掉全部能力，只加回 `SETUID`、`SETGID`、`KILL`。`no-new-privileges` 保持生效。
- `eos` 命令以 root 启动，降到 `eos` 时保留这三个能力（ambient）。
- 平台用 `SETUID`、`SETGID` 把检查命令切换到 `eos-check`、把 dsh 切换到 `eos-agent`；用 `KILL` 给它们的进程发信号（关闭 dsh、结束超时的命令）。
- 切换时清掉全部能力，所以检查命令和 dsh 不能切换回 `eos` 或 root。

### 哪些进程不带能力

规则：平台启动的进程只要会运行仓库代码或第三方程序，就先用 `setpriv` 清掉全部能力。

| 进程 | 启动方式 | 是否带能力 |
|---|---|---|
| dsh、agent、dsh 在沙箱外启动的 MCP 服务 | `deploy/dsh-launch.mjs`：清掉能力并切换到 `eos-agent` | 否 |
| git | `/usr/local/bin/git`（`deploy/git`） | 否 |
| 撤销越界改动用的 `sh`、`rm`、`find` | 平台启动前清掉能力 | 否 |
| Landlock 探测（doctor 运行一次 node-addon-system 自带的程序） | 平台直接启动 | 是 |
| tsx 的 esbuild 服务进程（编译平台自己的源码） | 平台直接启动 | 是 |

仍带能力的两个进程都不接触 worktree，也不运行仓库里的代码。

### 目录的归属和权限

| 目录 | 属主、组、权限 | 设计目的 |
|---|---|---|
| `/data/dsh` | `eos`、组 `eos-dsh`、3770（带 sticky 位） | dsh 在里面写会话日志等目录；检查命令不在 `eos-dsh` 组里，进不去 |
| `/data/dsh/eos-profiles/`（能力面）、`/data/dsh/eos-process-cwd/`（dsh 进程的工作目录） | 平台启动时创建，2755 | `eos-agent` 只读。sticky 位使它不能改名或删除这两个目录；平台写入前还核对它们不是符号链接 |
| `/data/dsh/mcp-cwd/` | 属于 `eos-agent` | MCP 服务在里面写缓存和日志；平台不往里写 |
| dsh 创建的会话目录 | 0700，只有 `eos-agent` 能读 | 平台以 `eos-agent` 的身份读取（`src/cli.ts` 的 `readSessionLogAs`） |
| `/data/worktrees` | 2755，带 setgid，组 `eos-work` | 目录本身组内不可写：检查命令不能把别的任务的 worktree 改名或换成符号链接 |
| 各任务的 worktree | 组 `eos-work`，平台的 umask 是 002 | 检查命令能写 agent 改过的文件 |

### 平台如何处理别的用户留下的进程和文件

平台读不到别的用户进程的工作目录，也可能读不了它们创建的文件，所以在两个时点借用它们的身份操作。

| 时点 | 平台做什么 | 原因 |
|---|---|---|
| 撤销越界改动之前 | 以 `eos-check`、`eos-agent` 的身份找出并结束它们留在 worktree 里的进程 | 平台自己看不到这些进程的工作目录 |
| 提交、撤销越界改动之前，以及检查命令结束之后 | 以 `eos-agent`、`eos-check` 的身份把它们在 worktree 里创建的文件改回 worktree 的组，并开放组读写 | dsh 写文件时经过一个 `chmod 0700` 的临时目录，文件落在 `eos-agent` 自己的组里、权限 0600，平台读不了 |

### 从旧版本升级

适用于 dsh 以 `eos` 运行的旧版本（`/data/dsh` 里的文件属于 `eos`）。

**自动迁移。** 新版本第一次启动平台时：

1. 以 `eos-agent` 的身份复制一份 `/data/dsh`。不复制 `.credentials.yaml`（dsh 自己的浏览器会话授权，dsh 会重新生成）。
2. 把旧目录改名为 `/data/dsh.before-agent`。
3. 写标记文件 `/data/.dsh-agent`。

进行中的任务能续接原来的 dsh 会话。确认任务正常后可以删除 `dsh.before-agent`。

**迁移被打断。** 最后两步之间被打断时，`/data/dsh` 不存在而 `/data/dsh.agent-new` 存在。此时除 `eos doctor` 外，`eos` 的命令（启动平台、`run`、`resume` 等）都不运行并给出提示。手工恢复：

```bash
docker compose run --rm -u eos eos mv /data/dsh.agent-new /data/dsh
docker compose up -d
```

**worktree 的组。** 升级前创建的 worktree 在第一次启动时改为 `eos-work` 组。`/data/.worktrees-group` 是已完成的标记。

**旧目录要删除。** 升级后遗留的 `/data/dsh/profiles/<指纹>/`、`/data/dsh/process-cwd/` 不再使用，它们属于 `eos-agent`。不删除时，dsh 启动的 MCP 服务可以把它们换成符号链接，使平台顺着链接覆盖 `eos.db` 等文件。删除命令：

```bash
docker compose run --rm -u eos-agent eos rm -rf /data/dsh/process-cwd
```

### 限制

- agent 和 dsh 是同一个用户。agent 读不到 dsh 进程环境里的模型 key，只依赖 Landlock。
- dsh 在沙箱外启动的 MCP 服务读得到模型 key。

## 沙箱

dsh 用 Landlock 限制 agent。镜像里装了 bubblewrap，但在 Docker 默认权限下不可用；启用它需要放宽容器的 seccomp 和 `/proc` 屏蔽，因此没有采用（见 ADR-006）。

### 沙箱限制什么

- **写入范围**：agent 只能写自己任务的 worktree 和 `/tmp`，写不了别的任务和数据目录。
- **别的进程的环境**：agent 读不到 dsh 和平台进程的 `/proc/<pid>/environ`，即读不到模型 key 和主密钥。

### 沙箱不限制什么

| 不限制的 | 后果 |
|---|---|
| 读文件 | agent 能读整个 `/data`：别的任务和别的成员的 worktree、`/data/repos` 下所有仓库、`eos.db`（所有任务的 trace）、`/data/dsh` 的会话日志。放进这台服务器的仓库和任务，对所有任务的 agent 可见 |
| `/tmp` | 同一容器里的任务共用 `/tmp`，并且都能写。能读到别的任务的临时文件和 dsh 的输出暂存文件（`/tmp/dsh-spill-*`） |
| 共享的依赖缓存 | 一个任务的 agent 放进缓存的内容会被下一个任务使用。npm 按 lockfile 里的 hash 校验包；pip 的缓存和 corepack 下载的 pnpm、yarn 没有这种校验 |
| 进程列表 | agent 能看到进程列表 |

### 模型 key 的保护依赖沙箱生效

这一版 dsh 只能从进程环境里得到模型 key，所以模型 key 在 dsh 进程的环境里。

- 验证过的配置：本镜像、这份 compose、内核 6.18。在这个配置下 Landlock 挡住了 agent 读取 dsh 和平台进程的环境。
- Landlock 没有生效时（内核不支持，或以别的方式运行而没有经过沙箱），同一用户的 agent 能读到模型 key。
- 更换宿主机内核后，用探针重新确认（见「证据」）。

### 内核不支持 Landlock 时

- dsh 拒绝执行命令，任务失败，不会在没有限制的状态下运行。
- `eos doctor` 的「沙箱」一项实际探测一次：按 dsh 的参数启动一次 bwrap，实际施加一次 Landlock 规则。两者都不可用时报 ✗。
- doctor 不检查 dsh 本身能否启动。doctor 全部为 ✓ 时，任务仍可能在第一步失败。

### 会被加载的缓存不放在 `/tmp`

agent 能写 `/tmp`。平台和 dsh 会加载的缓存如果放在那里，agent 写入的代码就会在沙箱外运行。因此：

| 缓存 | 处理 |
|---|---|
| tsx 的编译缓存 | 关闭 |
| Node 的字节码缓存 | 关闭 |
| dsh 的 native 模块缓存 | 放在平台用户的家目录（`NARB_NATIVE_CACHE_DIR`） |

例外：检查命令的环境里没有关闭字节码缓存的开关，npm 会在 `/tmp/node-compile-cache` 留下缓存（属于 `eos-check`），之后的检查命令会加载它。检查命令本来就在沙箱外运行 agent 改过的代码，这不会让 agent 获得更多权限。

`/tmp` 挂载为可执行，是因为 agent 运行测试和编译时要执行自己生成的文件。

### MCP 服务的启动方式

**不要用 `npx`、`pnpm dlx`、`uvx`、`pipx run` 这类下载后立即运行的命令启动 MCP 服务。**

- MCP 服务运行在沙箱外，并继承 dsh 的环境，包括上面的依赖缓存目录。
- 用这类命令启动时，它可能运行 agent 放进缓存的代码。
- 做法：把 MCP 服务安装进派生镜像（见「增加系统依赖」），在模板里写它的绝对路径。

## 数据和升级

### 数据目录

所有数据都在命名卷 `eos-data`，即容器里的 `/data`。

| 路径 | 内容 |
|---|---|
| `eos.db`（和 `-wal`、`-shm`） | 任务、事件、trace、约定、改进提案、加密的凭据 |
| `dsh/` | dsh 的会话日志（续跑和回放 trace 要用） |
| `worktrees/` | 每个任务的 worktree |
| `repos/` | 克隆的仓库：平台维护的 GitHub 镜像在 `repos/github.com/` 下，自行克隆的在 `repos/local/` 下 |
| `git-home/` | 平台访问远程仓库时 git 使用的空 HOME（不读宿主机或镜像里的 git 全局配置） |
| `logs/` | `eos.log` 和每个任务的日志 |
| `locks/` | 任务锁 |

### 备份

先停止容器，保证 SQLite 文件一致。`--volumes-from` 按容器查找卷，不需要知道卷名。

```bash
docker compose stop
docker run --rm --volumes-from "$(docker compose ps -aq eos)" -v "$PWD":/backup ubuntu:24.04 tar czf /backup/eos-data-$(date +%F).tgz -C /data .
docker compose start
```

### 恢复

`down -v` 会删除现有的数据卷。执行前先确认备份文件完好：`tar tzf <备份>` 能列出 `eos.db`。

```bash
docker compose down -v && docker compose create
docker run --rm --volumes-from "$(docker compose ps -aq eos)" -v "$PWD":/backup ubuntu:24.04 tar xzf /backup/<备份文件>.tgz -C /data
docker compose start
```

备份和恢复后文件属主保持不变。

### 升级

本节适用于在服务器上构建镜像的部署。使用发布的镜像（`.env` 里设置了 `EOS_IMAGE`）时不要用这组命令，按「用发布的镜像」里的步骤升级：`--build` 会用本地代码构建，覆盖拉下来的镜像。

```bash
git pull
docker compose -f compose.yaml build
docker compose up -d --build
```

第二行只重建 Eos 的基础镜像。使用派生镜像（`compose.override.yaml`）时必须先执行它，否则派生镜像建在旧的基础镜像上；没有派生镜像时它和第三行重复，没有副作用。

- 升级前先备份。
- 升级只替换容器，不改动数据卷。
- 没有运行完的任务在新容器启动后自动继续，已完成的调用不会重发。
- 数据库没有迁移机制：建表语句都是 `CREATE TABLE IF NOT EXISTS`，没有修改表结构的语句。

### 删除全部数据

`docker compose down -v`。不可恢复。

## 证据

正文里的结论对应的实测记录和测试：

| 结论 | 证据 |
|---|---|
| agent 和检查命令读不到主密钥；撤销越界改动用的命令不带能力；升级后任务能续接 dsh 会话 | `docs/e2e/deploy-3c-agent-user/`（其中 `without-caps.txt`） |
| 沙箱的写入范围；agent 读不到别的进程的环境 | `docs/e2e/deploy-2-image/sandbox/` |
| agent 读不到模型 key（更换内核后重新运行的探针） | `docs/e2e/deploy-2-image/sandbox/modelkey-probe.json` |
| 三种安装项目依赖的方式在沙箱里可用 | `docs/e2e/deploy-2-image/sandbox/deps-probe.json` |
| 检查命令不能把别的任务的 worktree 改名 | `docs/e2e/deploy-3b-check-user/probe-report.json` 的 `renameWorktreeDir` |
| 平台读不了 dsh 写出的 0600 文件 | `docs/e2e/deploy-3c-agent-user/` 的 `deploy-e2e-1-failed-report.json` |
| doctor 全部为 ✓ 时任务仍可能在第一步失败 | `docs/e2e/deploy-2-image/README.md` |
| 备份和恢复的命令，文件属主保持不变 | `docs/e2e/deploy-2-image/backup-restore.txt` |
| 镜像表和探针清单一致 | `tests/image-probe.test.ts` |
| dsh 的环境白名单 | `tests/agent-env-contract.test.ts` |
