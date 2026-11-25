#!/bin/sh
# ③b：同一个镜像在几种容器权限下 eos doctor 的「沙箱」「检查命令的用户」两项，以及 bwrap 带着能力时为什么会失败。不调用模型。
# 用法：sh scripts/check-user-doctor-configs.sh <镜像>（例如 check-user-probe.ts 建的 eos-workbench:check-user-probe）
set -u
image="$1"
key=$(openssl rand -base64 32)
base="--rm --cap-drop ALL --security-opt no-new-privileges:true -e EOS_MASTER_KEY=$key -e DEEPSEEK_API_KEY=sk-probe-not-a-real-key"
caps="--cap-add SETUID --cap-add SETGID --cap-add KILL"
bwrap="--security-opt seccomp=unconfined --security-opt systempaths=unconfined"
probe='bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true'

echo "# 镜像 $image"
echo; echo "## compose 的配置（去掉全部能力，加回 SETUID、SETGID、KILL；Docker 默认 seccomp）"
docker run $base $caps "$image" eos doctor 2>&1 | grep -E "沙箱|的用户|凭据隔离"
echo; echo "## 放开 seccomp 和 /proc 屏蔽（bwrap 能用）"
docker run $base $caps $bwrap "$image" eos doctor 2>&1 | grep -E "沙箱|的用户|凭据隔离"
echo; echo "## 同上，以平台的身份带着能力直接跑 bwrap（修之前 doctor 的做法），和清掉能力后跑"
docker run $base $caps $bwrap "$image" setpriv --reuid=eos --regid=eos --init-groups --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill -- \
  sh -c "echo 带着能力：; $probe; echo 退出码 \$?; echo 清掉能力：; setpriv --inh-caps=-all --ambient-caps=-all -- $probe; echo 退出码 \$?" 2>&1
echo; echo "## 去掉 cap_add（切换不了用户）"
docker run $base "$image" eos doctor 2>&1; echo "退出码 $?"
echo; echo "## 只加回 SETUID、SETGID（没有 KILL）"
docker run $base --cap-add SETUID --cap-add SETGID "$image" eos doctor 2>&1; echo "退出码 $?"
