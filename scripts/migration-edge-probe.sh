#!/bin/sh
# ③c：dsh 数据目录迁移的两种边界情况（第二轮独立审查发现的），不调用模型。
# 1. 迁移停在两次 mv 之间：/data/dsh 不在、dsh.agent-new 在。除了 eos doctor，eos 的命令（web、resume……）都不运行（退出码 1），也不动 dsh.agent-new。
# 2. 删了标记重做迁移：已经是新布局的 /data/dsh 不再复制（没有新的备份目录），eos-* 仍属于 eos，mcp-cwd 收紧到 2770。
# 用法：sh scripts/migration-edge-probe.sh <镜像>（例如 agent-user-probe.ts 建的 eos-workbench:agent-user-probe）
set -u
image="$1"
run="docker run --rm --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true -e DEEPSEEK_API_KEY=sk-probe-not-a-real-key $image"
as_eos="setpriv --reuid=eos --regid=eos --init-groups --"

echo "# 镜像 $image"
echo; echo "## 1. 迁移停在中间"
$run sh -c "$as_eos sh -c 'mkdir -p /data/dsh.agent-new/sessions /data/dsh.before-agent && echo keep > /data/dsh.agent-new/sessions/marker'
  timeout 20 eos web; echo \"eos web 退出码 \$?\"
  timeout 20 eos resume t-none >/dev/null 2>&1; echo \"eos resume 退出码 \$?\"
  timeout 20 eos doctor >/dev/null 2>&1; echo \"eos doctor 照常运行（退出码 \$?，没有 API key 等时可能是 1）\"
  ls -d /data/dsh 2>&1; cat /data/dsh.agent-new/sessions/marker" 2>&1

echo; echo "## 2. 删了标记重做迁移"
$run sh -c "timeout 15 eos web >/dev/null 2>&1; $as_eos rm -f /data/.dsh-agent
  timeout 15 eos web 2>&1 | grep 'eos：'; echo \"备份目录：\$(ls /data | grep -c before-agent) 个\"; $as_eos stat -c '%A %U:%G %n' /data/dsh /data/dsh/eos-profiles /data/dsh/eos-process-cwd /data/dsh/mcp-cwd
  eos doctor 2>&1 | grep -E '用户|隔离'" 2>&1
