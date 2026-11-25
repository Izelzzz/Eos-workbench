# Eos 平台镜像：Ubuntu 24.04 + Node 24 + git + bubblewrap，外加 agent 跑任务常用的 Python 3 和编译工具链。
# 执行器运行环境里有什么、仓库的依赖怎么装，见 docs/deploy.md「执行器环境」。

FROM node:24.22.3-bookworm-slim AS node

FROM ubuntu:24.04 AS base
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git bubblewrap \
      python3 python3-venv python3-pip build-essential pkg-config \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
# 可选的 build secret extra_ca：构建机在会解开 TLS 的代理后面时，传入代理的根证书（docker build --secret id=extra_ca,src=<证书>）。
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build:web

FROM base
# 三个用户（docs/adr/006-docker-deployment.md）：平台 eos；检查命令 eos-check，读不到平台和 dsh 进程的环境；
# 共用组 eos-work 让检查命令能写 worktree。数据目录 /data 是卷，第一次启动时由 Docker 按镜像里的属主创建。
RUN groupadd --gid 10010 eos-work \
 && useradd --create-home --uid 10001 --shell /bin/bash --groups eos-work eos \
 && useradd --create-home --uid 10002 --shell /usr/sbin/nologin --groups eos-work eos-check \
 && mkdir -p /data/repos && chown -R eos:eos /data
COPY --from=build --chown=root:root /app /app
COPY --chown=root:root --chmod=755 deploy/eos deploy/git /usr/local/bin/
WORKDIR /app
# 不设 NODE_ENV：dsh 把平台的环境传给 agent，NODE_ENV=production 会让 agent 的 npm install 不装 devDependencies。
ENV EOS_HOME=/data EOS_CHECK_USER=eos-check
# dsh 经 deploy/dsh-launch.mjs 启动：先清掉平台切换用户用的能力。
ENV EOS_DSH_LAUNCHER=/app/deploy/dsh-launch.mjs
# agent 在 Landlock 下能写 /tmp。平台和 dsh 会加载的缓存不能放在那里，否则 agent 能往里放代码、在沙箱外运行：
# 关掉平台 tsx 的编译缓存和 Node 的字节码缓存（dsh 会打开它，默认放在 /tmp）；dsh 的 native 模块缓存放到平台用户的家目录（agent 写不了）。
ENV TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 NARB_NATIVE_CACHE_DIR=/home/eos/.cache/native-addons
# 反过来，agent 装依赖时用的缓存要放在 agent 能写的地方：家目录在沙箱里不可写。
# 不设 XDG_CACHE_HOME：dsh 自己（沙箱外）也按它找缓存目录（例如 libreoffice-kit），不能指到 agent 能写的地方。
ENV npm_config_cache=/tmp/cache/npm PIP_CACHE_DIR=/tmp/cache/pip COREPACK_HOME=/tmp/cache/corepack
# 以 root 启动：eos 命令（deploy/eos）降到 eos，只带着切换用户用的 SETUID、SETGID。
# 进容器执行命令时用 docker compose exec eos eos <命令>；要以平台用户执行别的命令，加 -u eos。
VOLUME /data
EXPOSE 4317
CMD ["eos", "web", "--host", "0.0.0.0"]
