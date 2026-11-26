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
# 豁免清单的格式：每条都要有 id、purls（锁到版本）、statement（理由）、expired_at（YYYY-MM-DD）。
# 少了 expired_at 会永久豁免，少了 purls 会豁免所有包里的同一个漏洞，所以缺一项就不扫、直接报错
ign="$root/.trivyignore.yaml"
count() { grep -cE "^[[:space:]]*(- )?$1:" "$ign" || true; }
n=$(count id)
for k in purls statement expired_at; do
  if [ "$(count "$k")" -ne "$n" ]; then
    echo "::error title=镜像漏洞扫描::.trivyignore.yaml 里有 $n 条豁免，但 $k 只有 $(count "$k") 个：每条都要写 id、purls、statement、expired_at"
    exit 1
  fi
done
dates=$(sed -nE "s/^[[:space:]]*expired_at:[[:space:]]*['\"]?([0-9]{4}-[0-9]{2}-[0-9]{2})['\"]?[[:space:]]*(#.*)?$/\1/p" "$ign")
if [ "$(printf '%s\n' "$dates" | grep -c .)" -ne "$n" ]; then
  echo "::error title=镜像漏洞扫描::.trivyignore.yaml 里的 expired_at 要写成 YYYY-MM-DD"
  exit 1
fi
# 豁免 7 天内到期时先提示：到期那天起所有 PR 和发布都会被拦
today=$(date -u +%s)
for d in $(printf '%s\n' "$dates" | sort -u); do
  secs=$(( $(date -u -d "$d" +%s) - today ))
  if [ "$secs" -le 0 ]; then
    echo "::warning title=镜像漏洞扫描::.trivyignore.yaml 里有豁免 ${d} 已经过期，不再生效：扫描会按没有豁免处理"
  elif [ "$secs" -le $(( 7 * 86400 )) ]; then
    echo "::warning title=镜像漏洞扫描::.trivyignore.yaml 里有豁免 ${d} 到期（不到 $(( (secs + 86399) / 86400 )) 天）：到期后扫描会重新拦下，请提前重新评估"
  fi
done
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
  echo "::error title=镜像漏洞扫描::扫描没有通过（退出码 $status）。上面有漏洞表时：镜像里有已有修复版本的 HIGH/CRITICAL 漏洞，升级对应的包或基础镜像；确实暂时不能升级时，在 .trivyignore.yaml 里逐条加豁免（写理由和到期日，由人批准）。上面没有漏洞表时：是扫描本身失败了（拉 Trivy 镜像或下载漏洞库出错），看上面的报错，通常重跑即可"
  exit "$status"
fi
echo "镜像漏洞扫描通过（豁免的条目见上面 Suppressed 一节）"
