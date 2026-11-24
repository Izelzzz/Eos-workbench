#!/usr/bin/env bash
# 一键重跑 Claude Code 执行器 PoC。日志写到 logs/<real|mock>/。
# - 真实模式（默认）：需要环境变量 EOS_ANTHROPIC_API_KEY。另外设了 EOS_CLAUDE_OAUTH_TOKEN（`claude setup-token` 生成）时，
#   再用订阅令牌跑一次第 1 项。凭据只在本机的上游代理里使用，不进 agent 进程（见 upstream.ts、c8-env.ts）。
# - mock 模式：EOS_MOCK=1，不需要凭据，用 upstream.ts 里的剧本模型强制 agent 发起指定的工具调用。
# 需要 Node >= 22、npm、bubblewrap 和 socat（沙箱，第 3 项用）。
set -u
cd "$(dirname "$0")"
command -v bwrap >/dev/null && command -v socat >/dev/null || { echo "需要 bubblewrap 和 socat（Claude Code 的沙箱两个都要）：apt-get install -y bubblewrap socat"; exit 1; }
export POC="${POC:-$PWD/.run}" NODE_USE_ENV_PROXY=1 NODE_NO_WARNINGS=1
[ -f /root/.ccr/ca-bundle.crt ] && export NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt
[ -d node_modules ] || npm install --silent
mode=real; [ "${EOS_MOCK:-}" = 1 ] && mode=mock
[ $mode = real ] && [ -z "${EOS_ANTHROPIC_API_KEY:-}" ] && { echo "真实模式需要 EOS_ANTHROPIC_API_KEY（或用 EOS_MOCK=1）"; exit 1; }
rm -rf "$POC" "logs/$mode" && mkdir -p "logs/$mode"
run() { echo "== $1"; npx tsx "${@:2}" 2>&1 | tee "logs/$mode/$1.log" | grep -E '^(PASS|FAIL)|^mode='; }
run c1-resume-a c1-resume.ts a; run c1-resume-b c1-resume.ts b
run c2-ask c2-ask.ts
run c3-perms c3-perms.ts
run c4-recover-a c4-recover.ts a; run c4-recover-b c4-recover.ts b
run c5-events c5-events.ts
# 真实模型默认不给思考的文字（只有签名），再用 display: 'summarized' 跑一次对照
[ $mode = real ] && EOS_THINKING_DISPLAY=summarized run c5-events-summarized c5-events.ts
run c6-context c6-context.ts
run c7-abort c7-abort.ts
run c8-env c8-env.ts
if [ $mode = real ] && [ -n "${EOS_CLAUDE_OAUTH_TOKEN:-}" ]; then
  EOS_AUTH=oauth run c1-oauth-a c1-resume.ts a; EOS_AUTH=oauth run c1-oauth-b c1-resume.ts b
fi
echo "== 汇总"; if grep -h '^FAIL' logs/$mode/*.log; then exit 1; fi
# 每个带判定的脚本都要跑到最后一行（c1-resume-a、c4-recover-a 会 SIGKILL 自己，没有这一行）
for f in logs/$mode/*.log; do case $f in *c1-*-a.log|*c4-recover-a.log) ;; *) grep -q "^mode=$mode .* failed=0$" "$f" || { echo "没跑完：$f"; exit 1; } ;; esac; done
echo "没有 FAIL"
