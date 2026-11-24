# 凭据存储 PR 3：模型 key 取自凭据存储、dsh 环境白名单的 E2E 证据

运行：`node --import tsx scripts/model-key-probe.ts`

探针随机生成主密钥和一个 key，把 key 只存进凭据存储（名为 `deepseek`）。平台进程的环境里**没有** `DEEPSEEK_API_KEY`。然后跑一遍真实模型的 `npm run e2e`（deepseek、feature 模板，中途杀进程再续跑），运行期间每 50ms 扫一遍 `/proc`。

| 文件 | 内容 |
|---|---|
| `model-key-probe.json` | 探针的 8 项核对和明细：每个 dsh 进程的环境变量名、其他子进程的命令、doctor 的输出 |
| `e2e-report.json` | E2E 自己的 8 项核对，全部为 true |
| `e2e-run.log` | E2E 的完整输出 |

## 结论（8/8）

- 平台起了 5 个 dsh 进程。每个进程的 `DEEPSEEK_API_KEY` 都**等于凭据存储里的值**；环境变量只有 14 个，都在白名单里（`PATH HOME SHELL TERM TMPDIR`，代理和证书，`DSH_HOME`，`DEEPSEEK_API_KEY`）。
- 平台进程自己的环境里没有 `DEEPSEEK_API_KEY`。
- 平台起的其他 39 个子进程（git、检查命令、agent 的工具命令）环境里都没有这个 key。
- 跑完后 `eos doctor` 显示 `✓ DeepSeek API key：来自凭据存储（凭据 deepseek）`。
- 数据目录（数据库、WAL、日志、dsh 会话）的所有文件里都找不到 key 的明文。三个证据文件里也没有。

## 运行记录

- 证据是合入 main（#51）之后的代码跑的（单独运行，没有别的 Eos 进程同时在跑）。
- 合入后第一次运行时，同时还在跑 #51 的页面 E2E，它启动的 `eos web` 带着占位的 `DEEPSEEK_API_KEY`。探针把所有 `src/cli.ts` 进程都当作平台进程，所以「平台进程的环境里没有 DEEPSEEK_API_KEY」一项是 false，其余 7 项为 true。之后给探针加了 `platformWithModelKey`（列出是哪些进程），单独重跑，这一项为 true，列表为空。那次 false 是这个原因，是推断：当时没有记录具体是哪个进程。

## 局限

- 这个容器的代理会替换发往 api.deepseek.com 的 key，所以随机值也能调通模型。能证明 dsh 拿到的 key 来自凭据存储，**证明不了**存进去的值本身在 DeepSeek 那边有效。
- 按 50ms 间隔采样，活不到一个间隔的短命进程可能没被看到。
- 这次运行里没有任何输出碰巧带着凭据值，所以遮蔽在 E2E 里没有被触发过。遮蔽只有单元测试（`tests/redact.test.ts`、`tests/logs.test.ts`）。
