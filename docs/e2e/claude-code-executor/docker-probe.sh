#!/bin/sh
# 在部署镜像里实测 Claude Code 执行器的沙箱。用法（仓库根目录）：docs/e2e/claude-code-executor/docker-probe.sh <镜像>
# 容器的设置和 compose.yaml 一样：cap_drop ALL，只加 SETUID、SETGID、KILL，no-new-privileges，Docker 默认的 seccomp，/tmp 是 tmpfs。
# 先跑一次 eos doctor（deploy/eos 在这里准备数据目录），再以平台用户 eos 运行 docker-probe.mts。
# 把仓库的 src、deploy、tests/fake-anthropic.ts 挂进去：测的是工作区里的代码，不用重新构建镜像（镜像里装好的依赖不变）。
set -eu
image="$1"
dir="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$dir/../../.." && pwd)"
probe="$(mktemp -d "$root/node_modules/.eos-docker-probe-XXXXXX")"
cp "$dir/docker-probe.mts" "$root/tests/fake-anthropic.ts" "$probe/"
chmod -R a+rX "$probe"
echo "# 镜像 $image（$(docker image inspect -f '{{.Id}}' "$image")）；代码 $(git -C "$root" rev-parse HEAD)，src、deploy、tests/fake-anthropic.ts 里没提交的改动：$(git -C "$root" status --porcelain -- src deploy tests/fake-anthropic.ts | wc -l) 个文件"
docker run --rm \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:exec,size=1g \
  -e EOS_MASTER_KEY=probe-master-key-not-real \
  -v "$root/src:/app/src:ro" -v "$root/deploy:/app/deploy:ro" -v "$probe:/probe:ro" \
  --entrypoint sh "$image" -c '
    eos doctor | grep -E "Claude Code|Anthropic|沙箱|agent 的用户" || true
    cd /app
    exec setpriv --reuid=eos --regid=eos --init-groups --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill -- \
      env HOME=/home/eos USER=eos LOGNAME=eos node --import tsx /probe/docker-probe.mts'
