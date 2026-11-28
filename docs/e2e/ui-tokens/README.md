# 设计令牌和 Tailwind 的验证记录

| 证据 | 怎么来的 | 结论 |
|---|---|---|
| `report.json`、`run.log` | 真实模型 `npm run e2e`（dsh），提交 63130da | 18/18 项通过 |
| `pixels/compare.json` | `scripts/web-pixels.ts`：同一份数据目录（确定性 E2E 跑出的任务），改动前（main fcf4cc6 的构建）和改动后各截 10 页 × 亮暗色 × 1440/390 宽，逐像素比较 | 40 张全部相同 |
| `pixels/shots-*.json` | 两次截图的清单，固定时钟 2026-11-28T12:00:00Z，页面没有脚本错误 | — |
| `pixels/*.png` | 改动后的 4 张样张（含 390 宽、暗色） | — |
| `browser/*.json` | 不调用真实模型的浏览器 E2E：卡点（`gate-web-e2e.ts`）、凭据（`credentials-web-e2e.ts`）、对话（`chat-web-e2e.ts --fake`） | 14/14、16/16、14/14 |

改动前的截图稳定性：同一构建连截 3 次，40 张逐像素相同。
