# 用 Docker Compose 部署 Eos

本文面向在服务器上安装和维护 Eos 的人，说明怎样部署、访问、升级和备份。设计上的取舍不在本文，见 [ADR-006](adr/006-docker-deployment.md)。

## 部署前须知

**宿主机要求**

- Docker Engine 和 Compose v2。
- Linux 内核 5.13 以上，并且启用了 Landlock：`cat /sys/kernel/security/lsm` 的输出里有 `landlock`。

**安全注意事项**

| 事项 | 要做的 |
|---|---|
| Eos 没有登录，能打开地址的人权限相同 | 不要把端口暴露到网络上，按「访问」一节的两种方式访问 |
| 主密钥丢失后，存过的凭据只能重新录入 | 把 `.env` 里的 `EOS_MASTER_KEY` 另外备份一份 |
| 能使用 docker 的宿主机用户能看到主密钥 | 只让可信的人加入 docker 组 |
| agent 在特定条件下可能读到模型 key | 使用额度受限的模型 key |
| 一个任务的 agent 能读服务器上所有仓库和所有任务的记录 | 只放入对全体使用者都可见的仓库 |
| agent 访问网络不受限制 | 需要限制时在宿主机或 Docker 网络一层配置 |

## 启动

1. 克隆仓库。

   ```bash
   git clone https://github.com/Izelzzz/Eos-workbench.git && cd Eos-workbench
   ```

2. 在同一目录创建 `.env`。这个文件不要提交。

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

4. 检查运行环境，各项应为 ✓。

   ```bash
   docker compose exec eos eos doctor
   ```

5. 按「访问」一节打开页面。

**把模型 key 移到凭据页（可选）。** 启动后在 Web 的凭据页添加名为 `deepseek` 的凭据，再从 `.env` 删掉 `DEEPSEEK_API_KEY` 一行，执行 `docker compose up -d`。

**在容器里运行命令。** 平台的命令行是 `eos`（例如 `eos doctor`）。运行其他命令时加 `-u eos`：

```bash
docker compose exec -u eos eos git ...
```

## 用发布的镜像

不在服务器上构建时，使用发布到 ghcr 的镜像。拉取不需要登录。

### 可用的标签

| 标签 | 更新时机 |
|---|---|
| `ghcr.io/izelzzz/eos-workbench:<版本号>` | 推送 `v<版本号>` 标签时。例如 `v0.1.0` 发布 `0.1.0` |
| `ghcr.io/izelzzz/eos-workbench:latest` | 最近一次推送的正式版标签（版本号里没有 `-`）。给旧版本补发修订版时它也会指向那个修订版；一次推送多个正式版标签时，指向哪一个不确定 |
| `ghcr.io/izelzzz/eos-workbench:main` | 每次合并到 main。连续合并时只有最新的提交会推送；构建失败时不更新，停在上一个成功的提交 |
| `ghcr.io/izelzzz/eos-workbench:sha-<短提交号>` | 每次合并到 main。不会被覆盖 |

建议使用具体的版本号或 `sha-` 标签，不使用 `latest`、`main`。

### 步骤

1. 克隆仓库（需要其中的 `compose.yaml`），并检出和镜像一致的版本，例如 `git checkout v0.1.0`。
2. 按「启动」第 2 步创建 `.env`，再加一行指定镜像：

   ```bash
   echo 'EOS_IMAGE=ghcr.io/izelzzz/eos-workbench:0.1.0' >> .env
   ```

3. 拉取并启动。必须加 `--no-build`，否则会用本地代码构建并覆盖拉下来的镜像。

   ```bash
   docker compose pull
   docker compose up -d --no-build
   ```

### 升级和回退

升级前先备份（见「备份」）。

| 操作 | 步骤 |
|---|---|
| 升级 | 把 `.env` 里的 `EOS_IMAGE` 改成新标签，执行 `docker compose pull && docker compose up -d --no-build` |
| 回退 | 把 `EOS_IMAGE` 改回原标签，执行同样的命令 |

- 升级和回退都不改动数据。
- 升级后数据如果已被新版本修改，回退前先恢复升级前的备份。
- 同时使用派生镜像时，步骤不同，见「增加系统依赖」。

## 访问

平台只监听服务器的 `127.0.0.1:4317`。有两种访问方式。

### SSH 隧道（默认）

在自己的电脑上执行下面的命令，然后打开 http://localhost:4317 。

```bash
ssh -N -L 4317:127.0.0.1:4317 <服务器>
```

本地端口必须是 4317。要用别的本地端口时，把 `.env` 里的 `EOS_PUBLIC_URL` 设为 `http://localhost:<那个端口>`，再执行 `docker compose up -d`。

### 反向代理（用域名访问）

代理负责 HTTPS 和认证（例如 SSO 或 basic auth），转发到服务器的 `127.0.0.1:4317`。

1. 在 `.env` 里设置外部地址，执行 `docker compose up -d`。

   ```
   EOS_PUBLIC_URL=https://eos.example.com
   ```

2. 配置代理传递原始 Host。nginx 的配置：

   ```nginx
   location / {
     proxy_pass http://127.0.0.1:4317;
     proxy_set_header Host $http_host;
   }
   ```

### 不要直接暴露端口

不要把 `compose.yaml` 的端口改成 `0.0.0.0:4317` 或 `4317:4317`。

## 仓库放在哪里

新建任务时「仓库」一栏有两种填法。

### GitHub 地址

填 `https://github.com/<owner>/<repo>`，平台自己克隆。

访问私有仓库前，先完成下面两项：

1. `.env` 里设置了 `EOS_MASTER_KEY`。
2. 在 Web 的凭据页添加名为 `github.com` 的 Git 令牌。

### 容器里的路径

先把仓库克隆进容器的 `/data/repos/local/` 下，新建任务时填这个路径。

```bash
docker compose exec -u eos eos sh -c 'umask 022 && git clone https://github.com/<组织>/<仓库>.git /data/repos/local/<仓库>'
```

- `-u eos` 和 `umask 022` 都不能省。
- 不要把令牌写进 remote URL。

## 执行器环境

agent 运行任务时使用的就是这个镜像。

### 镜像里有什么

| 内容 | 版本 | 检查 |
|---|---|---|
| 系统 | Ubuntu 24.04 | `grep -qx 'VERSION_ID="24.04"' /etc/os-release` |
| Node、npm | Node 24（见 `Dockerfile` 第一行）；npm 换成了修过漏洞的版本（`Dockerfile` 里的 `NPM_VERSION`） | `node --version \| grep -q '^v24\.'`、`npm --version` |
| pnpm、yarn | 通过 corepack，按仓库 `package.json` 的 `packageManager` 字段取版本。镜像里没有预装，第一次用时联网下载 | `corepack --version`、`command -v pnpm`、`command -v yarn` |
| Python | 3.12，带 venv 和 pip | `python3 --version \| grep -q '^Python 3\.12\.'`、`python3 -m pip --version`、`python3 -m venv /tmp/probe-venv && /tmp/probe-venv/bin/python -m pip --version` |
| 编译 | build-essential（gcc、make）、pkg-config | `printf '#include <stdio.h>\nint main(void){return puts("ok") < 0;}\n' \| gcc -x c - -o /tmp/probe-c && /tmp/probe-c`、`printf '#include <vector>\nint main(){return std::vector<int>{0}[0];}\n' \| g++ -x c++ - -o /tmp/probe-cxx && /tmp/probe-cxx`、`make --version`、`pkg-config --version` |
| 其他 | git、ca-certificates、bubblewrap | `git --version`、`test -s /etc/ssl/certs/ca-certificates.crt`、`bwrap --version` |

「检查」一列是 CI 验证镜像时运行的命令（清单在 `.github/scripts/image-probe-checks.json`，修改时两处同时修改）。

### 安装项目依赖

项目自己的依赖由 agent 安装在任务的工作目录里，不需要部署方操作。支持：

- `npm install`
- `pnpm install`
- `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`

注意：

- agent 不能安装系统包（`apt-get` 会失败）。需要系统包时见「增加系统依赖」。
- 依赖缓存在 `/tmp/cache`。`/tmp` 的上限是 4g，重启容器后清空，依赖会重新下载。
- 要往家目录写缓存或配置的工具会失败，需要用它自己的配置把位置指到 `/tmp` 下。例如编译原生模块的 npm 包，在仓库的 `.npmrc` 里写 `devdir=/tmp/cache/node-gyp`。

### 增加系统依赖

需要镜像里没有的系统依赖（特定版本的 Python、Go、Java、系统库）时，使用派生镜像。

1. 编写 `Dockerfile.team`。不要加 `USER eos`。

   ```dockerfile
   FROM eos-workbench:local
   RUN apt-get update && apt-get install -y --no-install-recommends golang-go libpq-dev && rm -rf /var/lib/apt/lists/*
   ```

2. 编写 `compose.override.yaml`。镜像标签不能是 `eos-workbench:local`。

   ```yaml
   services:
     eos:
       build: { context: ., dockerfile: Dockerfile.team }
       image: eos-workbench:team
   ```

3. 先构建基础镜像，再构建派生镜像并启动。

   ```bash
   docker compose -f compose.yaml build
   docker compose up -d --build
   ```

**和发布的镜像一起用。** 此时 `.env` 里的 `EOS_IMAGE` 不起作用。

1. 把 `Dockerfile.team` 的 `FROM` 改成发布的标签，例如 `FROM ghcr.io/izelzzz/eos-workbench:0.1.0`。
2. 执行 `docker compose build --pull && docker compose up -d`。
3. 升级和回退时修改 `FROM` 里的标签，执行同样的命令。

### MCP 服务

- 把 MCP 服务安装进派生镜像，在 Agent 模板里写它的绝对路径。
- 不要用 `npx`、`pnpm dlx`、`uvx`、`pipx run` 这类下载后立即运行的命令启动 MCP 服务。

### 服务器经代理上网

平台把宿主环境里的代理和证书设置传给 agent 和检查命令（工作流里的 `npm test` 等）。

- 代理地址带账号密码（`http://user:pass@...`）时，不会传给检查命令，其中联网的步骤会失败，`eos doctor` 给出一条 ⚠。
- 带账号密码的代理地址仍会传给 agent。

## 用户和权限

容器以 root 启动，然后切换到三个普通用户运行：

| 用户 | 运行什么 |
|---|---|
| `eos` | 平台 |
| `eos-agent` | agent |
| `eos-check` | 检查命令 |

部署方需要遵守：

- 不要删除 `compose.yaml` 里的 `cap_add`（`SETUID`、`SETGID`、`KILL`）。删除后平台不启动。
- 派生镜像里不要加 `USER eos`。
- 在容器里手工运行命令时加 `-u eos`。以 root 创建的文件平台写不了。

各用户能读写什么，见 ADR-006。

## 数据和升级

### 数据在哪里

所有数据都在命名卷 `eos-data`，即容器里的 `/data`。

| 路径 | 内容 |
|---|---|
| `eos.db`（和 `-wal`、`-shm`） | 任务、事件、trace、约定、改进提案、加密的凭据 |
| `dsh/` | agent 的会话日志（续跑和回放 trace 要用） |
| `worktrees/` | 每个任务的工作目录 |
| `repos/` | 克隆的仓库：平台克隆的在 `repos/github.com/` 下，自行克隆的在 `repos/local/` 下 |
| `git-home/` | 平台运行 git 时使用的空 HOME |
| `logs/` | `eos.log` 和每个任务的日志 |
| `locks/` | 任务锁 |

### 备份

```bash
docker compose stop
docker run --rm --volumes-from "$(docker compose ps -aq eos)" -v "$PWD":/backup ubuntu:24.04 tar czf /backup/eos-data-$(date +%F).tgz -C /data .
docker compose start
```

### 恢复

`down -v` 会删除现有的数据。执行前先确认备份文件完好：`tar tzf <备份文件>` 能列出 `eos.db`。

```bash
docker compose down -v && docker compose create
docker run --rm --volumes-from "$(docker compose ps -aq eos)" -v "$PWD":/backup ubuntu:24.04 tar xzf /backup/<备份文件>.tgz -C /data
docker compose start
```

### 升级

本节适用于在服务器上构建镜像的部署。使用发布的镜像时按「用发布的镜像」里的步骤升级，不要用这组命令。

1. 备份。
2. 执行：

   ```bash
   git pull
   docker compose -f compose.yaml build
   docker compose up -d --build
   ```

- 升级不改动数据。
- 没有运行完的任务在新容器启动后自动继续。

### 从旧版本升级后的清理

适用于从「agent 和平台同一个用户」的旧版本升级上来的部署。新版本第一次启动时自动迁移 `/data/dsh`，进行中的任务能继续。

确认任务正常后，可以删除迁移留下的目录：

```bash
docker compose run --rm -u eos eos rm -rf /data/dsh.before-agent
docker compose run --rm -u eos-agent eos rm -rf /data/dsh/process-cwd
```

### 删除全部数据

`docker compose down -v`。不可恢复。

## 排查问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 容器不断重启，`docker compose exec` 不可用 | `.env` 和凭据页都没有模型 key | 用 `docker compose logs eos` 或 `docker compose run --rm eos eos doctor` 查看原因，补上 `DEEPSEEK_API_KEY` |
| `eos doctor` 的「沙箱」为 ✗ | 宿主机内核不支持 Landlock | 换用 5.13 以上并启用 Landlock 的内核 |
| `eos doctor` 的「检查命令的用户」为 ✗ | `compose.yaml` 里的 `cap_add` 被去掉了 | 恢复 `cap_add` |
| `eos doctor` 全部为 ✓，任务在第一步失败 | doctor 不检查 agent 的运行时能否启动 | 查看任务页的日志 |
| 浏览器返回 421 | SSH 隧道的本地端口不是 4317 | 改用 4317，或设置 `EOS_PUBLIC_URL`（见「SSH 隧道」） |
| 页面能打开，写操作返回 403 | 反向代理没有传递原始 Host | 按「反向代理」配置 |
| 启动时提示上次迁移停在了中间 | 迁移 `/data/dsh` 时被打断 | 执行 `docker compose run --rm -u eos eos mv /data/dsh.agent-new /data/dsh`，再执行 `docker compose up -d` |
| 检查命令里的 `npm install` 等联网步骤失败 | 代理地址带账号密码，没有传给检查命令 | 改用不带账号密码的代理 |
| 在容器的 `/app` 下执行 `npm run typecheck` 报 `tsc: not found` | 镜像里的平台目录不带 typescript | 类型检查在开发机上进行；任务仓库自己的 typescript 不受影响 |
| 升级后拿不到新的 Eos 代码 | 派生镜像沿用了 `eos-workbench:local` 标签，或没有先构建基础镜像 | 按「增加系统依赖」第 2、3 步修正 |
