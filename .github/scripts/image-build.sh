#!/usr/bin/env bash
# 按 image-tags.ts 的输出构建镜像并冒烟（.github/workflows/image.yml 的两个 job 共用，PR 里也走同一条路径）。
# 用法：image-build.sh <image-tags.ts 的输出文件>。不登录、不推送。
set -euo pipefail
out=$1
tags=$(sed -n 's/^tags=//p' "$out")
version=$(sed -n 's/^version=//p' "$out")
first=$(sed -n 's/^first=//p' "$out")
[ -n "$tags" ] && [ -n "$version" ] && [ -n "$first" ] || { echo "image-build.sh：$out 里缺 tags、version 或 first" >&2; exit 1; }
args=()
for t in $tags; do args+=(-t "$t"); done
docker build --pull "${args[@]}" \
  --label org.opencontainers.image.source="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \
  --label org.opencontainers.image.revision="$GITHUB_SHA" \
  --label org.opencontainers.image.version="$version" \
  .
# 冒烟：用和 compose.yaml 一样的能力和 no-new-privileges 启动，平台的启动包装要能降到 eos 用户。只走到命令行解析，不起 Web。
docker run --rm --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true "$first" eos --help > /dev/null
docker image inspect "$first" --format '{{json .Config.Labels}}'
