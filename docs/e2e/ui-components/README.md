# 基础组件的验证记录

| 证据 | 怎么来的 | 结论 |
|---|---|---|
| `report.json`、`run.log` | 真实模型 `npm run e2e`（dsh），提交 229a8d5，没有未提交的改动 | 18/18 项通过 |
| `gallery/` | `scripts/web-ui-gallery.ts`：组件样张（`scripts/ui-gallery/`，样式和网页相同）在 Chromium 里按亮暗色、1440/390 宽截图并核对样式取值、字体、现有 button 规则没有漏进组件、不横向滚动、对话框的焦点和 Esc、点按钮执行，提交 229a8d5 | 47/47 项通过 |
| `browser/*.json` | 不调用真实模型的浏览器 E2E：卡点（`gate-web-e2e.ts`）、凭据（`credentials-web-e2e.ts`）、对话（`chat-web-e2e.ts --fake`），提交 229a8d5 | 14/14、16/16、14/14 |

现有页面外观不变：`scripts/web-pixels.ts` 用同一份数据接连截 main（fcf4cc6）和本分支的构建，10 页 × 亮暗色 × 1440/390 宽共 40 张逐像素相同。原图没有放进仓库。
