#!/usr/bin/env bash
# 一键重跑 PoC。需要 Node >= 24.9、npm，以及可用的 DeepSeek key（环境变量 DEEPSEEK_API_KEY，云端会话里由代理注入）。
set -u
cd "$(dirname "$0")"
export POC="${POC:-$PWD/.run}" DSH_BIN="$PWD/node_modules/@deepseek-ai/dsh/lib/bin.js"
export NODE_USE_ENV_PROXY=1 DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-proxy-injected}"
[ -f /root/.ccr/ca-bundle.crt ] && export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
[ -d node_modules ] || npm install --silent
[ -d sdk-client ] || { git clone -q --depth 1 --branch main https://github.com/deepseek-ai/deepseek-harness.git .dsh-src && mkdir sdk-client && cp .dsh-src/packages/sdk/client/src/*.ts sdk-client/; }
rm -rf "$POC" && mkdir -p "$POC/ws" logs && git -C "$POC/ws" init -q
run() { echo "== $1"; node --import tsx "${@:2}" 2>&1 | tee "logs/$1.log" | tail -25; }
run p1-run p1-run.ts
run p2-resume-a p2-resume.ts a; run p2-resume-b p2-resume.ts b
run p3-ask p3-ask.ts
run p4-scope p4-scope.ts
run p5-observe p5-observe.ts "$(ls -t "$POC"/home/sessions/*/ | grep session- | head -1)"
