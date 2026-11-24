# 试用反馈第 2 条：启动检查和 `eos doctor`（真实运行）

脚本：`scripts/doctor-e2e.ts`。实际运行命令行，不打桩。用到两个 Node：
- 容器自带的 v22.23.5，低于 Eos 声明的 `>=24.9.0`
- 下载到临时目录的 v24.22.3

| 场景 | 结果 |
|---|---|
| Node 22，设置了 key：`eos doctor` | ⚠ Node（写明低于要求、照常启动、怎么修），其余 ✓，退出码 0 |
| Node 22，设置了 key：`eos run` | 先在 stderr 打印「启动前检查有提示（照常启动）」，然后用真实模型把任务跑完（规格 → 开发 → 测试 → 评审 → 交付） |
| Node 24，没有 key：`eos run`、`eos web` | 都不启动，写明「没有设置环境变量 DEEPSEEK_API_KEY」和怎么修，也没有建数据库 |
| Node 24：数据目录放在一个普通文件下面 | `eos doctor` 报 ✗ 数据目录：「路径里有一段不是目录（是普通文件）（ENOTDIR）」 |
| Node 24，设置了 key：`eos doctor` | 5 项全部 ✓，退出码 0 |
| Node 24，设置了 key：`eos run` | 通过检查，用真实模型把任务跑完 |

8/8，见 `report.json`，每条命令的完整输出在 `run.log`。

## 说明

- `report.json` 里的提交号是 982693d：脚本启动时，「Node 只提示」这个改动还在工作区里没提交，之后提交成 4e5ddfb，代码内容相同（`git diff 982693d 4e5ddfb` 只涉及 `src/cli.ts`、`src/runner/doctor.ts`、`tests/doctor.test.ts`，就是那次改动）。
- `run.log` 里每条命令先记 stdout 再记 stderr，所以「启动前检查有提示」出现在任务输出的后面。实际运行时它先打印。
- API key 由环境的代理注入，脚本只设了一个占位值。key 无效的情况这里测不了，见 PR 描述。
