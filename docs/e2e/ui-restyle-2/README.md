# 设计稿里的新组件的验证记录

| 证据 | 怎么来的 | 结论 |
|---|---|---|
| `report.json`、`run.log` | 真实模型 `npm run e2e`（dsh），提交 ede9f05（已合入 main 的 ec93dac），没有未提交的改动 | 18/18 项通过 |
| `vs-design/vs-design-{light,dark}.png` | `scripts/web-ui-vs-design.ts`：左边设计稿 `docs/design/workbench.html`，右边组件样张第一屏（按设计稿的当前卡片：步骤、选项、「其他」、继续），1440 宽 1:1 | 给用户确认像不像 |
| `gallery/`、`vs-design/gallery-*-390.png` | `scripts/web-ui-gallery.ts`：亮暗色 × 1440/390；新组件的点击和键盘操作（选项、「其他」和选项互斥、下拉菜单、分段切换）、任务行高度和窄屏隐藏进度，提交 ede9f05 | 77/77 项通过 |
| `pages/compare.json` | `scripts/web-pixels.ts`：同一份数据下 main（ec93dac）和本分支的构建各截 10 页 × 亮暗色 × 1440/390，逐像素比较 | 40 张全部相同：现有页面没用新组件，外观不变 |
| `browser/*.json` | 不调用真实模型的浏览器 E2E：卡点、凭据、对话（假模型），提交 ede9f05 | 14/14、16/16、14/14 |
