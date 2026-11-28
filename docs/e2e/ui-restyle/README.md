# 按设计稿改令牌和现有组件的验证记录

| 证据 | 怎么来的 | 结论 |
|---|---|---|
| `report.json`、`run.log` | 真实模型 `npm run e2e`（dsh），提交 a47b371，没有未提交的改动 | 18/18 项通过 |
| `vs-design/vs-design-{light,dark}.png` | `scripts/web-ui-vs-design.ts`：左边设计稿 `docs/design/workbench.html`（拦掉 Google Fonts，和网页一样用系统字体），右边组件样张第一屏，都是 1440 宽、1:1 | 给用户确认像不像 |
| `vs-design/gallery-{light,dark}-390.png`、`gallery/` | `scripts/web-ui-gallery.ts`：组件样张亮暗色 × 1440/390，核对令牌取值、聚焦外框、字体、现有 button 规则没漏进组件、不横向滚动、对话框焦点和 Esc，提交 a47b371 | 51/51 项通过 |
| `pages/*.jpg` | `scripts/web-pixels.ts`：同一份数据下 main（e6a3000）和本分支的构建各截 10 页 × 亮暗色 × 1440/390；每张左边改前、右边改后（1440 宽的缩到一半） | 40 张都变了，是预期的：只换颜色和字号，页面结构不变 |
| `browser/*.json` | 不调用真实模型的浏览器 E2E：卡点、凭据、对话（假模型），提交 a47b371 | 14/14、16/16、14/14 |
