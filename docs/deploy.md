# 用 Docker Compose 部署 Eos

适合一个小团队共用一台服务器。设计和取舍见 [ADR-006](adr/006-docker-deployment.md)。

> **模型 key 对 agent 只靠沙箱挡住。** 平台、agent、检查命令是三个不同的用户（见「用户和权限」）：主密钥只在平台进程的环境里，agent 和检查命令都读不到（`docs/e2e/deploy-3c-agent-user/`）。模型 key 在 dsh 进程的环境里，检查命令读不到；agent 是 dsh 启动的，和 dsh 是同一个用户，读不到它靠的是 Landlock（见「沙箱」）。dsh 在沙箱外启动的 MCP 服务能读到模型 key。模型 key 请用额度受限的。
>
> **没有登录。** 能打开 Eos 地址的人都能建任务、看所有 trace、在服务器的仓库上跑 agent。默认只监听服务器的 `127.0.0.1`，请保持这个默认，或者放在带认证的反向代理后面。登录是路线图第 7 项。

## 启动

需要 Docker Engine 和 Compose v2。宿主机内核要支持 Landlock（Linux 5.13 以上并启用了 landlock：`cat /sys/kernel/security/lsm` 的输出里要有 `landlock`），原因见下面的「沙箱」。

```bash
git clone https://github.com/Izelzzz/Eos-workbench.git && cd Eos-workbench
```

在同一目录建 `.env`，只给自己读。这个文件不要提交：

```bash
umask 077
cat > .env <<EOF
DEEPSEEK_API_KEY=<你的 key>
EOS_MASTER_KEY=$(openssl rand -base64 32)
EOF
```

```bash
docker compose up -d --build
```

检查运行环境：

```bash
docker compose exec eos eos doctor
```

镜像里的 `eos` 命令就是平台的命令行（`eos web`、`eos doctor`……）。容器以 root 启动，`eos` 先降到平台用户再运行，见下面的「用户和权限」。在容器里运行别的命令时加 `-u eos`，以平台用户运行，例如 `docker compose exec -u eos eos git ...`。

- 模型 key 先看凭据存储里名为 `deepseek` 的凭据，没有才用 `.env` 里的 `DEEPSEEK_API_KEY`。第一次启动要靠 `.env`。两边都没有时平台不会起来，compose 会一直重启它，`docker compose exec` 用不了；看原因用 `docker compose logs eos`，或 `docker compose run --rm eos eos doctor`。启动后可以在 Web 的凭据页添加 `deepseek`，再从 `.env` 删掉这一行并 `docker compose up -d`。
- `EOS_MASTER_KEY` 是凭据存储的主密钥（ADR-005）。**弄丢了，存过的凭据只能重新录入**，请另外备份一份。它只以环境变量的形式进容器，不写进容器的文件系统。能用 docker 的宿主机用户可以用 `docker inspect` 或 `docker compose config` 看到它，所以这台服务器上 docker 组的成员要可信。
- 「沙箱」一项报告 dsh 实际会用的沙箱：在这份 compose 下是 Landlock（镜像里装了 bwrap，但 Docker 默认权限下用不了）。两个都用不了时是 ✗，平台不启动。
- 「检查命令的用户」一项真正切换一次到 `eos-check`。切换不过去（例如 compose 里去掉了 `cap_add`）时是 ✗，平台不启动：不会退回到用平台的用户运行检查命令。
- 「凭据隔离」一项现在是 ⚠：检查命令读不到平台和 dsh 进程的环境，agent 只靠沙箱挡住（见顶部的警告）。

## 访问

平台在容器里监听 `0.0.0.0:4317`，compose 只把它映射到服务器的 `127.0.0.1:4317`。

**SSH 隧道（默认）。** 在自己的电脑上运行下面的命令，然后打开 http://localhost:4317：

```bash
ssh -N -L 4317:127.0.0.1:4317 <服务器>
```

本地端口要和容器里的端口一样是 4317。换成别的本地端口时，浏览器发的 Host 是 `localhost:<那个端口>`，平台会拒绝（421）。这种情况把 `.env` 里的 `EOS_PUBLIC_URL` 设成 `http://localhost:<那个端口>`。

**反向代理（需要用域名访问时）。** 代理负责 HTTPS 和认证（例如 SSO 或 basic auth），转发到服务器的 `127.0.0.1:4317`。在 `.env` 里设置：

```
EOS_PUBLIC_URL=https://eos.example.com
```

代理必须把原始 Host 传过来。nginx 的配置：

```nginx
location / {
  proxy_pass http://127.0.0.1:4317;
  proxy_set_header Host $http_host;
}
```

没有传原始 Host 时，页面能打开，但所有写操作都会被拒绝（403），提示里会写明原因。

**不要**把 compose 的端口改成 `0.0.0.0:4317` 或 `4317:4317`。这样整个网络都能访问，而且非浏览器客户端可以伪造 Host 绕过检查。

## 仓库放在哪里

每个任务在 `/data/worktrees/<任务id>` 建自己的 worktree 和分支 `eos/<任务id>`。新建任务时，「仓库」一栏填下面两种之一：

- **GitHub 地址**（`https://github.com/<owner>/<repo>`）：平台自己克隆到 `/data/repos/github.com/<owner>/<repo>.git`，在默认分支的最新提交上建分支。私有仓库要先在 Web 的凭据页添加名字为 `github.com` 的 Git 令牌（需要设置 `EOS_MASTER_KEY`）。令牌只由平台的 git 进程使用，不进数据目录。推分支和开 PR 是路线图第 2 项后面的 PR。
- **容器里的路径**：自己先克隆进去。为了不和平台的镜像混在一起，建议放在 `/data/repos/local/` 下：

  ```bash
  docker compose exec -u eos eos sh -c 'umask 022 && git clone https://github.com/<组织>/<仓库>.git /data/repos/local/<仓库>'
  ```

  `-u eos`：以 root 克隆的话，平台写不了这个仓库。`umask 022`：`docker compose exec` 起的进程 umask 是 0，不设的话克隆出来的文件人人可写，检查命令也能改。不要把令牌写进这种仓库的 remote URL：agent 能读整个 `/data`（见下面的「沙箱」）。

## 执行器环境

agent 跑任务时的环境，就是这个镜像：

| 内容 | 版本 |
|---|---|
| 系统 | Ubuntu 24.04 |
| Node、npm | Node 24（见 `Dockerfile` 第一行） |
| pnpm、yarn | 通过 corepack，按仓库 `package.json` 的 `packageManager` 字段取版本。镜像里没有预装，第一次用时联网下载 |
| Python | 3.12，带 venv 和 pip |
| 编译 | build-essential（gcc、make）、pkg-config |
| 其他 | git、ca-certificates、bubblewrap |

agent 以普通用户运行，只能写自己任务的 worktree，所以**跑任务时装不了系统包**（`apt-get` 会失败）。

- **项目自己的依赖**照常装进 worktree：`npm install`、`pnpm install`、`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`。在沙箱里实测过这三种（`docs/e2e/deploy-2-image/sandbox/deps-probe.json`）。
- 包管理器的缓存在 `/tmp/cache`（npm、pip、corepack），因为家目录在沙箱里不可写。`/tmp` 是 tmpfs（默认上限 4g），重启容器后缓存清空，依赖和 pnpm、yarn 会重新下载。
- 别的工具如果要写家目录，在沙箱里会失败，需要用它自己的环境变量把缓存或配置指到 worktree 或 `/tmp` 下。例如需要编译原生模块的 npm 包（node-gyp 要写 `~/.cache/node-gyp`）：在仓库的 `.npmrc` 里写 `devdir=/tmp/cache/node-gyp`（实测能传到安装脚本，但 npm 11 会警告这个配置项下个大版本不再支持）。镜像没有统一设 `XDG_CACHE_HOME`，因为 dsh 自己（在沙箱外）也按它找缓存目录。
- **需要别的系统依赖**（某个版本的 Python、Go、Java、系统库）时，写一个基于 Eos 镜像的 Dockerfile，例如 `Dockerfile.team`：

  ```dockerfile
  FROM eos-workbench:local
  RUN apt-get update && apt-get install -y --no-install-recommends golang-go libpq-dev && rm -rf /var/lib/apt/lists/*
  ```

  不要加 `USER eos`：容器要以 root 启动，`eos` 命令才能降到平台用户、并带上切换到 `eos-check` 的能力（见「用户和权限」）。

  再写一个 `compose.override.yaml`（compose 会自动读它），给派生镜像一个**不同的标签**：

  ```yaml
  services:
    eos:
      build: { context: ., dockerfile: Dockerfile.team }
      image: eos-workbench:team
  ```

  第一次部署和每次升级都要先建基础镜像，再建派生镜像，见下面的「升级」。派生镜像沿用 `eos-workbench:local` 这个标签的话，它会盖掉基础镜像，以后升级拿不到新的 Eos 代码。

- agent 访问网络不受限制（拉依赖要用到）。需要限制出网时，在宿主机或 Docker 网络这一层做。
- **检查命令**（工作流里的 `npm test` 等，由平台在沙箱外运行）以 `eos-check` 运行，只拿到最少的环境变量：`PATH`、语言和时区、`CI=1`，`HOME` 是 `/home/eos-check`（npm 等的缓存在这里，各任务的检查命令共用）。另外传证书和代理设置（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 及小写形式、`NODE_USE_ENV_PROXY`），服务器经代理上网时联网的检查（`npm install` 等）也能跑。**代理地址带账号密码（`http://user:pass@...`）时不传**：检查命令跑的是 agent 改过的代码，会把账号密码带出去。这时 `eos doctor` 有一条 ⚠，联网的检查会失败。agent 那一边（dsh 的环境）现在还拿得到完整的代理地址，下一个 PR 按同样的规则收紧。

## 用户和权限

容器里有四个用户（ADR-006）：

| 用户 | 运行什么 | 能读 | 能写 |
|---|---|---|---|
| root | 只有 1 号进程（`docker-init`），以及 `docker compose exec` 不加 `-u` 时的命令 | 只有 `SETUID`、`SETGID`、`KILL` 三个能力，读写不了别的用户的文件 | 同左 |
| `eos` | 平台、git；平台进程自己带着 `SETUID`、`SETGID`、`KILL` | `/data` 全部（dsh 的会话日志以 `eos-agent` 的身份读）、自己进程的环境（主密钥） | `/data` 全部，`/data/dsh` 里 dsh 自己建的 0700 目录除外 |
| `eos-agent` | dsh、agent、dsh 启动的 MCP 服务 | 世界可读的文件、`/data/dsh`、dsh 进程的环境（模型 key；agent 在 Landlock 里读不到）；读不到 `eos` 和 root 进程的环境 | dsh：`/data/dsh`（共用组 `eos-dsh`）、worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；agent 在 Landlock 里只能写自己的 worktree 和 `/tmp` |
| `eos-check` | 检查命令 | 世界可读的文件，包括 `/data` 下大部分（`eos.db`、仓库、worktree）；读不到别的用户进程的环境，进不了 `/data/dsh` | worktree（共用组 `eos-work`）、自己的家目录、`/tmp`；写不了 `eos.db`、`repos/`、`eos` 的家目录 |

- compose 去掉了全部能力，只加回 `SETUID`、`SETGID`、`KILL`。`eos` 命令以 root 启动，降到 `eos` 时把这三个能力带过去（ambient）：平台用前两个把检查命令切换到 `eos-check`、把 dsh 切换到 `eos-agent`，用 `KILL` 给它们的进程发信号（关掉 dsh、结束超时的命令）。切换时清掉全部能力，它们切换不回 `eos` 或 root。`no-new-privileges` 照常生效。
- dsh 的数据目录 `/data/dsh` 属于 `eos`、组 `eos-dsh`、3770（带 sticky 位）：dsh 在里面写会话日志等自己的目录。平台自己的三个目录 `eos-profiles/`（能力面）、`eos-process-cwd/`、`eos-mcp-cwd/` 在启动时建好，2755，`eos-agent` 只能读；sticky 位让它改不了名、删不掉这几个目录，平台写之前也核对它们不是符号链接。否则 dsh 起的 MCP 服务能把它们换成链接，让平台顺着链接覆盖 `eos.db` 等文件（独立审查实测过）。dsh 建的会话目录是 0700，只有 `eos-agent` 能读，平台以 `eos-agent` 的身份读（`src/cli.ts` 的 `readSessionLogAs`）。检查命令不在 `eos-dsh` 里，进不了这个目录。
- worktree 归共用组 `eos-work`（`/data/worktrees` 带 setgid，平台的 umask 是 002），检查命令能写 agent 改过的文件。`/data/worktrees` 目录本身是 2755，组内不可写：检查命令不能把别的任务的 worktree 改名或换成符号链接（独立审查发现的，`probe-report.json` 的 `renameWorktreeDir`）。升级前建的 worktree 在第一次启动时改成这个组（`/data/.worktrees-group` 是做过的标记）。
- 平台启动的、会运行仓库代码或第三方程序的进程不带这三个能力：dsh 经 `deploy/dsh-launch.mjs` 启动（清掉能力并切换到 `eos-agent`），git 经 `/usr/local/bin/git`（`deploy/git`），都先用 `setpriv` 清掉全部能力。所以 agent、dsh 在沙箱外启动的 MCP 服务、git 都切换不了用户。平台撤销越界改动时用的 `sh`、`rm`、`find` 也先清掉能力（`docs/e2e/deploy-3c-agent-user/without-caps.txt`）。还带着能力的只有 Landlock 探测（doctor 起一次 node-addon-system 自带的程序）和 tsx 的 esbuild 服务进程（编译平台自己的源码），它们都不碰 worktree，也不运行仓库里的代码。
- 平台读不到别的用户进程的工作目录：撤销越界改动前，以 `eos-check`、`eos-agent` 的身份找出并结束它们留在 worktree 里的进程。
- 平台提交、撤销越界改动之前（以及检查命令跑完之后），以 `eos-agent`、`eos-check` 的身份把它们在 worktree 里建的文件改回 worktree 的组、开放组读写。dsh 写文件时经过一个 `chmod 0700` 的临时目录，文件会落在 `eos-agent` 自己的组里、权限 0600，不这样做平台读不了（第一次部署 E2E 就失败在这里，`deploy-e2e-1-failed-report.json`）。
- **升级**：之前的版本里 dsh 以 `eos` 运行，`/data/dsh` 里的文件属于 `eos`。新版本第一次启动平台时，以 `eos-agent` 的身份把它复制一份（不复制 `.credentials.yaml`，dsh 会重新生成，里面是 dsh 自己的浏览器会话授权），旧的改名为 `/data/dsh.before-agent`。进行中的任务能续接原来的 dsh 会话（`docs/e2e/deploy-3c-agent-user/`）。确认任务都正常后可以删掉 `dsh.before-agent`。`/data/.dsh-agent` 是做过的标记。迁移在最后两步之间被打断时（`/data/dsh` 不在、`/data/dsh.agent-new` 在），平台不启动并提示：手工运行 `docker compose run --rm -u eos eos mv /data/dsh.agent-new /data/dsh` 再 `docker compose up -d`。
- **还没做到的**：agent 和 dsh 是同一个用户，读不到 dsh 进程环境里的模型 key 只靠 Landlock；dsh 在沙箱外启动的 MCP 服务读得到它。

## 沙箱

- dsh 用 Landlock 限制 agent 的写入范围：只能写自己任务的 worktree 和 `/tmp`，写不了别的任务和数据目录，也读不到别的进程的环境（模型 key、主密钥）。实测记录在 `docs/e2e/deploy-2-image/sandbox/`。
- **模型 key 在 dsh 进程的环境里**（这一版 dsh 只能这样拿到 key）。在实测过的配置下（本镜像、这份 compose、内核 6.18），Landlock 挡住了 agent 读 dsh 和平台进程的 `/proc/<pid>/environ`（`docs/e2e/deploy-2-image/sandbox/modelkey-probe.json`）。**Landlock 没有生效时**，例如内核不支持、或者用别的方式运行没有走沙箱，同一用户的 agent 就能读到模型 key。换了宿主机内核时，请用这个探针重新确认。
- **Landlock 只限制写，不限制读。** agent 能读整个 `/data`：别的任务和别的成员的 worktree、`/data/repos` 下所有仓库、`eos.db`（所有任务的 trace）、`/data/dsh` 的会话日志。放进这台服务器的仓库和任务，对所有任务的 agent 都是可见的。
- 镜像里装了 bubblewrap，但在 Docker 默认权限下用不了。要用它就得放宽容器的 seccomp 和 `/proc` 屏蔽，所以没有这样做（见 ADR-006）。
- 宿主机内核没有 Landlock 时，dsh 会拒绝执行命令，任务会失败，不会不受限制地运行。`eos doctor` 的「沙箱」一项会真正探测一次（bwrap 按 dsh 的参数起一次，Landlock 真正施加一次规则），都用不了时报 ✗。它不检查 dsh 本身能不能启动：doctor 全是 ✓ 时，任务仍可能在第一步失败（部署 E2E 第一次运行就遇到过，见 `docs/e2e/deploy-2-image/README.md`）。
- 和 bwrap 相比的差别：
  - 同一个容器里的任务共用 `/tmp`（tmpfs），而且都能写：能读到别的任务的临时文件和 dsh 的输出暂存文件（`/tmp/dsh-spill-*`）；也能改共享的依赖缓存，一个任务的 agent 往缓存里放的东西，会被下一个任务用到。npm 按 lockfile 里的 hash 校验包，pip 的缓存和 corepack 下载的 pnpm、yarn 没有这种校验。
- **MCP 服务不要用 `npx`、`pnpm dlx`、`uvx`、`pipx run` 这类「现下载现运行」的命令启动。** MCP 服务跑在沙箱外，并继承 dsh 的环境，包括上面这几个缓存目录；用这类命令启动时，它可能运行 agent 放进缓存里的代码。把 MCP 服务装进派生镜像（见「执行器环境」），在模板里写它的绝对路径。
  - agent 能看到进程列表。
- agent 能写 `/tmp`，所以平台和 dsh 会加载的缓存都不放在那里：镜像关掉了 tsx 的编译缓存和 Node 的字节码缓存，dsh 的 native 模块缓存放在平台用户的家目录（`NARB_NATIVE_CACHE_DIR`）。检查命令是例外：它的环境里没有关字节码缓存的开关，npm 会在 `/tmp/node-compile-cache` 留下缓存（属于 `eos-check`），之后的检查命令会加载它。检查命令本来就在沙箱外运行 agent 改过的代码，所以这不会让 agent 多拿到权限。`/tmp` 挂成可执行，是为了 agent 跑测试和编译时能执行自己生成的文件。

## 数据和升级

所有数据都在命名卷 `eos-data`（容器里的 `/data`）：

| 路径 | 内容 |
|---|---|
| `eos.db`（和 `-wal`、`-shm`） | 任务、事件、trace、约定、改进提案、加密的凭据 |
| `dsh/` | dsh 的会话日志（续跑和回放 trace 要用） |
| `worktrees/` | 每个任务的 worktree |
| `repos/` | 克隆的仓库：平台维护的 GitHub 镜像在 `repos/github.com/` 下，自己克隆的放在 `repos/local/` 下 |
| `git-home/` | 平台访问远程仓库时 git 用的空 HOME（不读宿主机或镜像里的 git 全局配置） |
| `logs/` | `eos.log` 和每个任务的日志 |
| `locks/` | 任务锁 |

**备份**。先停下来，保证 SQLite 文件一致。`--volumes-from` 按容器找卷，不用知道卷名：

```bash
docker compose stop
docker run --rm --volumes-from "$(docker compose ps -aq eos)" -v "$PWD":/backup ubuntu:24.04 tar czf /backup/eos-data-$(date +%F).tgz -C /data .
docker compose start
```

**恢复**。`down -v` 会删掉现在的数据卷，先确认备份文件完好（`tar tzf <备份>` 能列出 `eos.db`）：

```bash
docker compose down -v && docker compose create
docker run --rm --volumes-from "$(docker compose ps -aq eos)" -v "$PWD":/backup ubuntu:24.04 tar xzf /backup/<备份文件>.tgz -C /data
docker compose start
```

这两组命令实测过，文件属主会保留（`docs/e2e/deploy-2-image/backup-restore.txt`）。

**升级**：

```bash
git pull
docker compose -f compose.yaml build
docker compose up -d --build
```

- 第二行只重建 Eos 的基础镜像。用了派生镜像（`compose.override.yaml`）时必须先跑它，否则派生镜像会建在旧的基础镜像上；没有派生镜像时它和第三行重复，没有坏处。
- 换的只是容器，卷不动。升级前先备份。
- 没跑完的任务会在新容器启动后自动接着跑，已完成的调用不会重发。
- 数据库现在没有迁移：建表都是 `CREATE TABLE IF NOT EXISTS`，没有改表的语句。以后有不兼容的变更，会在发布说明里写迁移步骤。

**删除全部数据**：`docker compose down -v`。不可恢复。
