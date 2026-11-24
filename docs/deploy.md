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

- `EOS_MASTER_KEY` 是凭据存储的主密钥（ADR-005）。**弄丢了，存过的凭据只能重新录入**，请另外备份一份。它只以环境变量的形式进容器，不写进容器的文件系统。
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
  proxy_set_header Host $host;
}
```

没有传原始 Host 时，页面能打开，但所有写操作都会被拒绝（403），提示里会写明原因。

**不要**把 compose 的端口改成 `0.0.0.0:4317` 或 `4317:4317`。这样整个网络都能访问，而且非浏览器客户端可以伪造 Host 绕过检查。

## 仓库放在哪里

任务在服务器上的 git 仓库里运行：每个任务在 `/data/worktrees/<任务id>` 建自己的 worktree 和分支 `eos/<任务id>`。新建任务时填的仓库路径是**容器里的路径**，约定放在 `/data/repos` 下：

```bash
docker compose exec eos git clone https://github.com/<组织>/<仓库>.git /data/repos/<仓库>
```

私有仓库的克隆和推送要等路线图第 2 项（GitHub 接入）由平台持有令牌来做。在那之前，不要把令牌写进仓库的 remote URL，agent 能读到它。

## 执行器环境

agent 跑任务时的环境，就是这个镜像：

| 内容 | 版本 |
|---|---|
| 系统 | Ubuntu 24.04 |
| Node、npm | Node 24（见 `Dockerfile` 第一行） |
| pnpm、yarn | 通过 corepack，按仓库 `package.json` 的 `packageManager` 字段取版本 |
| Python | 3.12，带 venv 和 pip |
| 编译 | build-essential（gcc、make）、pkg-config |
| 其他 | git、ca-certificates、bubblewrap |

agent 以普通用户运行，只能写自己任务的 worktree，所以**跑任务时装不了系统包**（`apt-get` 会失败）。

- **项目自己的依赖**照常装进 worktree：`npm install`、`pnpm install`、`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`。在沙箱里实测过这三种（`docs/e2e/deploy-2-image/sandbox/deps-probe.json`）。
- 包管理器的缓存在 `/tmp/cache`（npm、pip、corepack），因为家目录在沙箱里不可写。`/tmp` 是 tmpfs，重启容器后缓存清空，依赖会重新下载。
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

  升级时先重建基础镜像，再重建派生镜像：`docker compose -f compose.yaml build && docker compose up -d --build`。派生镜像沿用 `eos-workbench:local` 这个标签的话，它会盖掉基础镜像，以后升级拿不到新的 Eos 代码。

- agent 访问网络不受限制（拉依赖要用到）。需要限制出网时，在宿主机或 Docker 网络这一层做。

## 沙箱

- dsh 用 Landlock 限制 agent 的写入范围：只能写自己任务的 worktree，写不了别的任务和数据目录，也读不到别的进程的环境（模型 key、主密钥）。实测记录在 `docs/e2e/deploy-2-image/sandbox/`。
- 镜像里装了 bubblewrap，但在 Docker 默认权限下用不了。要用它就得放宽容器的 seccomp 和 `/proc` 屏蔽，所以没有这样做（见 ADR-006）。
- 宿主机内核没有 Landlock 时，dsh 会拒绝执行命令，任务会失败，不会不受限制地运行。`eos doctor` 现在还不检查这一项，也不检查 dsh 能不能真正启动：例如 `/tmp` 挂成 `noexec` 时，dsh 的 native 模块加载不了，doctor 照样全是 ✓，任务一开始就失败。
- 和 bwrap 相比的差别：
  - 同一个容器里的任务共用 `/tmp`（tmpfs）：能读到别的任务的临时文件、dsh 的输出暂存文件（`/tmp/dsh-spill-*`）和依赖缓存。
  - agent 能看到进程列表。
- agent 能写 `/tmp`，所以平台和 dsh 会加载的缓存都不放在那里：镜像关掉了 tsx 的编译缓存和 Node 的字节码缓存，dsh 的 native 模块缓存放在平台用户的家目录（`NARB_NATIVE_CACHE_DIR`）。`/tmp` 挂成可执行，是为了 agent 跑测试和编译时能执行自己生成的文件。

## 数据和升级

所有数据都在命名卷 `eos-data`（容器里的 `/data`）：

| 路径 | 内容 |
|---|---|
| `eos.db`（和 `-wal`、`-shm`） | 任务、事件、trace、约定、改进提案、加密的凭据 |
| `dsh/` | dsh 的会话日志（续跑和回放 trace 要用） |
| `worktrees/` | 每个任务的 worktree |
| `repos/` | 克隆的仓库 |
| `logs/` | `eos.log` 和每个任务的日志 |
| `locks/` | 任务锁 |

**备份**。先停下来，保证 SQLite 文件一致：

```bash
docker compose stop
docker run --rm -v eos-workbench_eos-data:/data -v "$PWD":/backup ubuntu:24.04 tar czf /backup/eos-data-$(date +%F).tgz -C /data .
docker compose start
```

卷名是「compose 项目名_eos-data」，项目名默认是目录名；用 `docker volume ls` 确认。

**升级**：

```bash
git pull
docker compose up -d --build
```

- 换的只是容器，卷不动。升级前先备份。
- 没跑完的任务会在新容器启动后自动接着跑，已完成的调用不会重发。
- 数据库现在没有迁移：建表都是 `CREATE TABLE IF NOT EXISTS`，没有改表的语句。以后有不兼容的变更，会在发布说明里写迁移步骤。

**删除全部数据**：`docker compose down -v`。不可恢复。
