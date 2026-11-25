#!/usr/bin/env bash
# 检查仓库里全部代码文件的格式（Prettier，配置在同目录的 prettier.config.json）。
# 范围：git 跟踪的 .ts/.tsx/.mts/.cts/.js/.mjs/.cjs，不含仓库根目录的 docs/、poc/、vendor/；
# 任意深度的 node_modules/、dist/ 按同目录的 .prettierignore 跳过。json、yaml、css、md 不管。
#
# 用法（仓库根目录）：
#   bash .github/lint/check-format.sh          检查，不改文件（CI 用这个）
#   bash .github/lint/check-format.sh --write  按同样的范围把文件格式化
# 先装工具：npm ci --prefix .github/lint --ignore-scripts
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# 在子目录里运行也按整个仓库算
cd "$(git rev-parse --show-toplevel)"
case "${1:-}" in
  "") mode=--check ;;
  --write) mode=--write ;;
  *) echo "用法：bash .github/lint/check-format.sh [--write]" >&2; exit 2 ;;
esac
# 先写进临时文件：git ls-files 失败时 set -e 能让脚本失败（进程替换里的失败不会）
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
git ls-files -z -- '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.mjs' '*.cjs' \
  ':(exclude,top)docs/' ':(exclude,top)poc/' ':(exclude,top)vendor/' >"$list"
files=()
while IFS= read -r -d '' f; do files+=("$f"); done <"$list"
if [ "${#files[@]}" -eq 0 ]; then
  echo "::error title=格式::一个代码文件也没找到"
  exit 1
fi
if [ "$mode" = --write ]; then
  echo "格式化 ${#files[@]} 个代码文件"
  "$here/node_modules/.bin/prettier" --config "$here/prettier.config.json" --no-editorconfig --ignore-path "$here/.prettierignore" --log-level warn --write -- "${files[@]}"
  echo "已格式化，用 git diff 看改了哪些文件"
  exit 0
fi
echo "检查 ${#files[@]} 个代码文件的格式"
if ! "$here/node_modules/.bin/prettier" --config "$here/prettier.config.json" --no-editorconfig --ignore-path "$here/.prettierignore" --log-level warn --check -- "${files[@]}"; then
  echo "::error title=格式::有文件没有按 Prettier 格式化。本地运行：bash .github/lint/check-format.sh --write"
  exit 1
fi
echo "格式都对"
