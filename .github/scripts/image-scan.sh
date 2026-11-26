#!/usr/bin/env bash
# 用 Trivy 扫描 image-build.sh 构建好的镜像（.github/workflows/image.yml 的两个 job 共用：PR 里扫，发布时推送之前扫）。
# 只拦 HIGH、CRITICAL 里已有修复版本的漏洞，范围是系统软件包和镜像里的 npm 包。豁免逐条写在仓库根目录的 .trivyignore.yaml
# （写明理由和到期日，过期自动失效；改它属于重档，要人批准）。
# Trivy 用官方镜像、按 digest 锁定；镜像先 docker save 成文件再扫，不把 docker.sock 交给扫描容器。
# 用法：image-scan.sh <image-tags.ts 的输出文件>
set -euo pipefail
TRIVY=aquasec/trivy:0.76.2@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb
out=$1
first=$(sed -n 's/^first=//p' "$out")
[ -n "$first" ] || { echo "image-scan.sh：$out 里缺 first" >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d "${RUNNER_TEMP:-/tmp}/image-scan.XXXXXX")
trap 'rm -rf "$work"' EXIT
# 扫描前先校验豁免清单（写法、每条四项写全、快到期和已过期的提示），见 trivyignore-check.ts
node "$root/.github/scripts/trivyignore-check.ts" "$root/.trivyignore.yaml" "$(date -u +%F)"
docker save "$first" -o "$work/image.tar"
mkdir -p "$work/cache"
status=0
# 以当前用户运行：缓存目录里的漏洞库是当前用户的文件，结束时能删掉。漏洞库每次都下载最新的（不锁版本）：
# 漏洞库里新出的、已有修复版本的漏洞会让不相干的 PR 和发布变红，这是有意的（用户的决定），处理方法见下面的报错
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$work/image.tar:/scan/image.tar:ro" \
  -v "$root/.trivyignore.yaml:/scan/.trivyignore.yaml:ro" \
  -v "$work/cache:/cache" \
  "$TRIVY" image --input /scan/image.tar --cache-dir /cache \
  --scanners vuln --pkg-types os,library --severity HIGH,CRITICAL --ignore-unfixed \
  --ignorefile /scan/.trivyignore.yaml --show-suppressed \
  --exit-code 1 --no-progress --format table || status=$?
if [ "$status" -ne 0 ]; then
  echo "::error title=镜像漏洞扫描::扫描没有通过（退出码 $status）。上面有漏洞表时：镜像里有已有修复版本的 HIGH/CRITICAL 漏洞，升级对应的包或基础镜像；确实暂时不能升级时，在 .trivyignore.yaml 里逐条加豁免（写理由和到期日，由人批准）。上面没有漏洞表时：是扫描本身失败了，看上面 Trivy 或 docker 的报错（拉镜像、下载漏洞库出错时重跑即可）"
  exit "$status"
fi
echo "镜像漏洞扫描通过（豁免的条目见上面 Suppressed 一节）"
