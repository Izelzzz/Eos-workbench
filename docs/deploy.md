# 用 Docker Compose 部署 Eos

适合一个小团队共用一台服务器。设计和取舍见 [ADR-006](adr/006-docker-deployment.md)。

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
docker compose exec eos node --import tsx src/cli.ts doctor
```

- 模型 key 先看凭据存储里名为 `deepseek` 的凭据，没有才用 `.env` 里的 `DEEPSEEK_API_KEY`。第一次启动要靠 `.env`（两边都没有时平台不启动）。启动后可以在 Web 的凭据页添加 `deepseek`，再从 `.env` 删掉这一行并 `docker compose up -d`。
- `EOS_MASTER_KEY` 是凭据存储的主密钥（ADR-005）。**弄丢了，存过的凭据只能重新录入**，请另外备份一份。它只以环境变量的形式进容器，不写进容器的文件系统。能用 docker 的宿主机用户可以用 `docker inspect` 或 `docker compose config` 看到它，所以这台服务器上 docker 组的成员要可信。
- 「凭据隔离」一项现在是 ⚠：agent 和检查命令还和平台是同一个用户，这是路线图第 3 项下一个 PR 要做的事。

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
  docker compose exec eos git clone https://github.com/<组织>/<仓库>.git /data/repos/local/<仓库>
  ```

  不要把令牌写进这种仓库的 remote URL：agent 能读整个 `/data`（见下面的「沙箱」）。

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
- 包管理器的缓存在 `/tmp/cache`（npm、pip、corepack，以及遵循 `XDG_CACHE_HOME` 的工具，例如 node-gyp），因为家目录在沙箱里不可写。`/tmp` 是 tmpfs（默认上限 4g），重启容器后缓存清空，依赖和 pnpm、yarn 会重新下载。
- 别的工具如果要写家目录，在沙箱里会失败，需要用它自己的环境变量把缓存或配置指到 worktree 或 `/tmp` 下。
- **需要别的系统依赖**（某个版本的 Python、Go、Java、系统库）时，写一个基于 Eos 镜像的 Dockerfile，例如 `Dockerfile.team`：

  ```dockerfile
  FROM eos-workbench:local
  USER root
  RUN apt-get update && apt-get install -y --no-install-recommends golang-go libpq-dev && rm -rf /var/lib/apt/lists/*
  USER eos
  ```

  再写一个 `compose.override.yaml`（compose 会自动读它），给派生镜像一个**不同的标签**：

  ```yaml
  services:
    eos:
      build: { context: ., dockerfile: Dockerfile.team }
      image: eos-workbench:team
  ```

  第一次部署和每次升级都要先建基础镜像，再建派生镜像，见下面的「升级」。派生镜像沿用 `eos-workbench:local` 这个标签的话，它会盖掉基础镜像，以后升级拿不到新的 Eos 代码。

- agent 访问网络不受限制（拉依赖要用到）。需要限制出网时，在宿主机或 Docker 网络这一层做。

## 沙箱

- dsh 用 Landlock 限制 agent 的写入范围：只能写自己任务的 worktree 和 `/tmp`，写不了别的任务和数据目录，也读不到别的进程的环境（模型 key、主密钥）。实测记录在 `docs/e2e/deploy-2-image/sandbox/`。
- **Landlock 只限制写，不限制读。** agent 能读整个 `/data`：别的任务和别的成员的 worktree、`/data/repos` 下所有仓库、`eos.db`（所有任务的 trace）、`/data/dsh` 的会话日志。放进这台服务器的仓库和任务，对所有任务的 agent 都是可见的。
- 镜像里装了 bubblewrap，但在 Docker 默认权限下用不了。要用它就得放宽容器的 seccomp 和 `/proc` 屏蔽，所以没有这样做（见 ADR-006）。
- 宿主机内核没有 Landlock 时，dsh 会拒绝执行命令，任务会失败，不会不受限制地运行。`eos doctor` 现在还不检查这一项，也不检查 dsh 能不能真正启动：doctor 全是 ✓ 时，任务仍可能在第一步失败（部署 E2E 第一次运行就遇到过，见 `docs/e2e/deploy-2-image/README.md`）。
- 和 bwrap 相比的差别：
  - 同一个容器里的任务共用 `/tmp`（tmpfs），而且都能写：能读到别的任务的临时文件和 dsh 的输出暂存文件（`/tmp/dsh-spill-*`）；也能改共享的依赖缓存，一个任务的 agent 往缓存里放的东西，会被下一个任务用到。npm 按 lockfile 里的 hash 校验包，pip 的缓存和 corepack 下载的 pnpm、yarn 没有这种校验。
  - agent 能看到进程列表。
- agent 能写 `/tmp`，所以平台和 dsh 会加载的缓存都不放在那里：镜像关掉了 tsx 的编译缓存和 Node 的字节码缓存，dsh 的 native 模块缓存放在平台用户的家目录（`NARB_NATIVE_CACHE_DIR`）。`/tmp` 挂成可执行，是为了 agent 跑测试和编译时能执行自己生成的文件。

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
