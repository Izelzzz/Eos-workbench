#!/usr/bin/env bash
# 检查新增代码文件的格式（Prettier，配置在同目录的 prettier.config.json）。
# 第二批定的做法：新增的文件必须格式化；存量文件不在这里查，择机一次性格式化。
# 改名的文件不算新增（git 按改名识别，--diff-filter=A 不选它）。
#
# 用法（仓库根目录）：bash .github/lint/check-format.sh [base]
#   CI 里 base 是 HEAD^1（检出的合并提交相对 base 的改动）；本地可以用 origin/main
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
base="${1:-HEAD^1}"
# base 解析不了（历史取得太浅、本地没 fetch）时必须失败，不能当成「没有新文件」放过去
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "::error title=格式::找不到 base 提交 $base，没法算出新增的文件"
  exit 1
fi
# 先写进临时文件：git diff 失败时 set -e 能让脚本失败（进程替换里的失败不会）
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
# 三个点：和 base 的分叉点比，本地用 origin/main 时结果和 CI 一样
# --find-renames：改名不算新增，不受本地 diff.renames 配置影响
git diff --name-only --find-renames --diff-filter=A -z "$base"...HEAD -- '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.mjs' '*.cjs' \
  ':(exclude,top)docs/' ':(exclude,top)poc/' ':(exclude,top)vendor/' >"$list"
files=()
while IFS= read -r -d '' f; do files+=("$f"); done <"$list"
if [ "${#files[@]}" -eq 0 ]; then
  echo "没有新增的代码文件，不需要检查格式"
  exit 0
fi
echo "新增的代码文件（根目录的 docs/、poc/、vendor/ 不查，node_modules/、dist/ 按 .prettierignore 跳过）："
printf '  %s\n' "${files[@]}"
if ! "$here/node_modules/.bin/prettier" --config "$here/prettier.config.json" --no-editorconfig --ignore-path "$here/.prettierignore" --check "${files[@]}"; then
  echo "::error title=格式::新增的文件没有按 Prettier 格式化。本地运行：.github/lint/node_modules/.bin/prettier --config .github/lint/prettier.config.json --no-editorconfig --write <文件>"
  exit 1
fi
