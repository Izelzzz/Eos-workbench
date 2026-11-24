# doctor 按实际生效的沙箱报告（路线图第 3 项 PR ③a）

## 怎么跑的

镜像用仓库里的 `Dockerfile` 构建，在三种权限配置下运行 `eos doctor`，命令和输出在 `container-doctor.txt`（处理独立审查之后的代码）。每次都带 compose 的 `--cap-drop ALL --security-opt no-new-privileges`。

| 配置 | doctor「沙箱」 | 退出码 |
|---|---|---|
| Docker 默认权限（等同 `compose.yaml`） | ✓ Landlock（bwrap 用不了） | 0 |
| `seccomp=unconfined` + `systempaths=unconfined` | ✓ bwrap | 0 |
| Docker 默认 seccomp，再让 Landlock 的三个系统调用返回 ENOSYS（模拟内核没有 Landlock） | ✗ bwrap 和 Landlock 都用不了 | 1 |

「凭据隔离」一项（设置了主密钥时）：前两种写的是「agent 在沙箱里读不到；检查命令读得到」，第三种写的是「agent 和检查命令都能读到」。修复提示不再说「Docker 部署会这样做」。

## doctor 的判断和 dsh 实际的选择一致吗

用 #56 的写入探针（`docs/e2e/deploy-2-image/sandbox/container-probe.mts`，真实 dsh + 真实模型）在后两种配置下各跑一次：

- `dsh-backend-bwrap.json`：agent 写进了自己的 worktree，没有写进真实 `/tmp`（bwrap 的私有 `/tmp`），只看得到 6 个进程。dsh 用的是 bwrap，和 doctor 一致。
- `dsh-backend-none.json`：agent 连自己的 worktree 都没写进去，`/proc` 报告也没写出来，说明 dsh 拒绝执行命令，和 doctor 的 ✗ 一致。

第一种配置（Landlock）的对照在 `docs/e2e/deploy-2-image/sandbox/compose-final.json`：agent 写进了真实 `/tmp`，写不了别的 worktree。

## doctor 和 dsh 自己的选择一致（单元测试）

`tests/executor.test.ts`「agrees with the backend dsh itself selects」直接调用 dsh 选后端的那一步（`LocalSandboxProvider` 的 `chainVerdict()`），要求和 `dshSandbox()` 的结果相同。dsh 升级后两边不一致时，这条测试会在那台机器上失败。

`consistency-test.txt`：这条测试在三种容器配置下都通过。变异测试：让 `dshSandbox` 跳过 bwrap、在 bwrap 可用的容器里跑，测试失败，报 `landlock` 和 `bwrap` 不一致。注意：这条测试只能发现在运行它的那台机器上看得出来的不一致。宿主机和 CI 上没有 bwrap，所以 bwrap 那一支只在 bwrap 可用的容器里才测得到。

上面 `dsh-backend-*.json` 两份是处理独立审查之前的镜像（提交 75c9ba2 之后、9bfdb7b 之前），探测逻辑和最终代码相同。`dsh-backend-none.json` 没有记下 dsh 的拒绝报错，只能看出命令没有执行；一致性测试在同一配置下确认了 dsh 自己的选择是不可用。

## 部署 E2E

`scripts/deploy-e2e.ts`（真实模型，compose），在合入 main（#62、#63）后的提交 511a889 上跑：6 项核对全部为 true，任务 `t2611241841395wz` 完成，agent 提了 2 个问题、经接口回答。合入前在 9bfdb7b 上也跑通过一次。之后处理独立审查时改了说明文字、非 Linux 平台的分支，并加了一致性测试，探测逻辑没有变，没有重跑部署 E2E。容器里的 doctor 输出（报告的 `doctor` 字段）里「沙箱」一项是 Landlock。见 `deploy-e2e-report.json`、`deploy-e2e-run.log`。

## 最终提交上的部署 E2E：被模型账户余额挡住

处理独立审查并合入 #66 之后，在 062217d 和 82b229e 上各跑了一次部署 E2E，任务都在规格那一步的第一次调用就失败了（`deploy-e2e-final-blocked-report.json`：「这一轮没有正常完成（出错）」）。原因是模型账户余额不足：`model-api-balance.txt` 是直接调用模型 API 的结果，返回 `Insufficient Balance`。这和本 PR 的改动无关，doctor 那一项在同一次运行里照常报了 Landlock。所以最后一次能通过的部署 E2E 是 511a889 那次。

## 局限

- 「没有 Landlock」是用 seccomp 让系统调用返回 ENOSYS 模拟的，不是真正没有 Landlock 的内核。
- Landlock 的 `partial`（旧 ABI）没有实测，只有单元测试。
- 非 Linux 平台（macOS、Windows）不探测，只有单元测试。
