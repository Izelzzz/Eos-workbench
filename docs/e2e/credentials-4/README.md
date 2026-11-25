# dsh 环境白名单按名字放行 DSH_、换 key 重起进程：E2E 证据

运行：`node --import tsx scripts/model-key-probe.ts`。这一次单独运行，没有别的 Eos 进程同时在跑。

和 `docs/e2e/credentials-3/` 用的是同一个探针：模型 key 只放在凭据存储里，跑一遍真实模型的 `npm run e2e`，同时扫描 `/proc`。

| 文件 | 内容 |
|---|---|
| `model-key-probe.json` | 探针的 8 项核对和明细 |
| `e2e-report.json` | E2E 自己的 8 项核对，全部为 true |
| `e2e-run.log` | E2E 的完整输出 |

## 结论（8/8）

- 5 个 dsh 进程：`DEEPSEEK_API_KEY` 都等于凭据存储里的值。每个进程有 15 个环境变量，`notAllowed` 都是空的：
  - `PATH HOME SHELL TERM TMPDIR`；
  - 代理和证书，`npm_config_cache`；
  - SDK 设置的 `DSH_HOME`，以及模型 key。
  - 没有别的 `DSH_` 变量。
- 平台进程（这次 E2E 起的 `src/cli.ts`）的环境里没有 `DEEPSEEK_API_KEY`。其他 40 个子进程里也没有这个 key。
- doctor 显示 key 来自凭据存储；数据目录里找不到 key 的明文。

## 探针这次的修改

- 平台进程只算这次 E2E 起的 `src/cli.ts`。之前同时在跑的 `npm test`（doctor 测试会起带占位 key 的 cli）被误算成平台进程。
- `DSH_HOME` 由 SDK 设置（`vendor/dsh-sdk-client/launch.ts`），不算越过白名单。

修改前的一次运行（和独立审查的 `npm test` 同时跑）有 2 项为 false，原因就是这两条。没有保留那次的证据文件。

## 局限

- E2E 里没有换过 key：换 key 重起进程只有单元测试（`tests/executor.test.ts` 的 3 个测试）。
- 代理会替换发往 api.deepseek.com 的 key，所以存进去的值本身是否有效证明不了。
