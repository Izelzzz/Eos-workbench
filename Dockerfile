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
# 平台以非 root 用户运行。数据目录 /data 是卷，第一次启动时由 Docker 按镜像里的属主创建。
RUN useradd --create-home --uid 10001 --shell /bin/bash eos \
 && mkdir -p /data/repos && chown -R eos:eos /data
COPY --from=build --chown=root:root /app /app
WORKDIR /app
ENV EOS_HOME=/data NODE_ENV=production
# agent 在 Landlock 下能写 /tmp。平台和 dsh 会加载的缓存不能放在那里，否则 agent 能往里放代码、在沙箱外运行：
# 关掉平台 tsx 的编译缓存和 Node 的字节码缓存（dsh 会打开它，默认放在 /tmp）；dsh 的 native 模块缓存放到平台用户的家目录（agent 写不了）。
ENV TSX_DISABLE_CACHE=1 NODE_DISABLE_COMPILE_CACHE=1 NARB_NATIVE_CACHE_DIR=/home/eos/.cache/native-addons
# 反过来，agent 装依赖时用的缓存要放在 agent 能写的地方：家目录在沙箱里不可写。
ENV npm_config_cache=/tmp/cache/npm PIP_CACHE_DIR=/tmp/cache/pip COREPACK_HOME=/tmp/cache/corepack
USER eos
VOLUME /data
EXPOSE 4317
CMD ["node", "--import", "tsx", "src/cli.ts", "web", "--host", "0.0.0.0"]
