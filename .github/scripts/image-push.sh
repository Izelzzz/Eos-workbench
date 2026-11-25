#!/usr/bin/env bash
# 推送 image-tags.ts 算出的标签（.github/workflows/image.yml 的 publish job，已经登录 ghcr）。
# 用法：image-push.sh <image-tags.ts 的输出文件>。需要 GITHUB_SHA、GITHUB_REPOSITORY、GITHUB_API_URL、TOKEN（只读仓库内容即可）。
#
# main 上每个提交单独发布、可能并行跑，旧提交可能比新提交晚推完。浮动标签 main 推送前核对 main 分支现在还指向这个提交，
# 不是就跳过（更新的那次发布会推它）。sha- 和版本号标签每次都推。
set -euo pipefail
out=$1
current_main() {
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.github+json' \
    "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/commits/main" | jq -r .sha
}
for t in $(sed -n 's/^tags=//p' "$out"); do
  if [ "${t##*:}" = main ]; then
    head=$(current_main)
    if [ "$head" != "$GITHUB_SHA" ]; then
      echo "跳过 $t：main 已经是 ${head:-（读不到）}，不是 $GITHUB_SHA"
      continue
    fi
  fi
  docker push "$t"
done
