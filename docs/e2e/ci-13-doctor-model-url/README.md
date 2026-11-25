# doctor 的「模型接口地址」检查项的证据（提交 2e6bc0e）

- `run.log`、`report.json`：真实模型 E2E（`npm run e2e`，没设 `EOS_MODEL_BASE_URL`），8 项核对全部通过。doctor 在每次 `eos run` 启动前执行，本 PR 改了它，按 CLAUDE.md 跑一次。
- `doctor-cases.txt`：`eos doctor` 在几种 `EOS_MODEL_BASE_URL` 下的输出，以及地址不合法时 `eos run` 在启动前被拦下。带密码的那一例在本文件里把密码替换成了 `***`（doctor 的输出本身不含密码，见 `tests/doctor.test.ts`）。
