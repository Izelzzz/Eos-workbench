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
USER eos
VOLUME /data
EXPOSE 4317
CMD ["node", "--import", "tsx", "src/cli.ts", "web", "--host", "0.0.0.0"]
