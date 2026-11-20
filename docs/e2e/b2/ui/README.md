# 第 2 块 T4：团队约定页的 Agent 模板与技能（真实浏览器验证）

`ui-e2e.ts` 用 Playwright 驱动真实 Chromium 走一遍页面，28 项检查全部通过（运行日志 `run.log`），截图就是下面这些。
不调用模型：任务页用的那个任务由 `seed-task.ts` 直接写进 store（`resolve()` 算出用了哪些约定版本）。

## 怎么重跑

```bash
npm run build:web
node --import tsx src/cli.ts web --data .eos/t4 --port 4417 &
NODE_PATH=/opt/node-tools/node_modules node --import tsx docs/e2e/b2/ui/ui-e2e.ts
```

数据目录要是空的（`rm -rf .eos/t4`），截图才和这里一致。`NODE_PATH` 指向装了 playwright 的地方；
playwright 不在仓库依赖里，只用来跑这个验证。换端口用 `EOS_E2E_BASE`，换数据目录用 `EOS_E2E_DATA`。

## 截图各自证明什么

| 截图 | 证明 |
| --- | --- |
| `01-四栏与介绍` | 侧栏四栏「工作流 / 约定文档 / Agent 模板 / 技能」各带「新建」；模板那栏显示可写范围和说明，技能那栏显示说明；介绍改成了四种约定 |
| `02-新建技能的起始文本` | 新建技能给的是合法的 frontmatter 加正文，上面一行中文说明名字取自哪里 |
| `03-技能的中文错误带位置` | 正文删空后，边写边校验报 `(正文)：技能正文不能为空` |
| `04-技能已保存` | 保存后跳到这个技能的页面，标题写「技能 · 当前第 1 版」，侧栏立刻多出它和它的说明 |
| `05-新建模板的起始文本` | 新建模板的起始文本逐字段带中文注释（tools.deny 的六个工具组、writePaths 的含义） |
| `06-…-工具组` | `tools.deny[0]：只能是 web、subagent、bash、schedule、todo、goal 之一`，保存按钮不可点 |
| `06b-…-只读与可写范围` | `writePaths：只读（write: none）的角色不需要 writePaths……`（字段之间的检查） |
| `06c-…-技能不存在` | `skills[0]：平台上没有名为「nope」的技能` |
| `07-模板已保存` | 改好后提示「格式正确，可以保存」，保存后跳到模板页 |
| `08-未保存的改动` | 编辑器里的改动相对当前版本的 diff |
| `09-历史版本与折叠 diff` | 两个版本都在、各带说明；第 2 版相对第 1 版的 diff 折叠了未改动的行 |
| `10-看第一版的改动` | 点历史里的「第 1 版」看那一版的内容 |
| `11-任务页用到的约定版本` | 任务页在工作流旁边显示 `Agent 模板 auditor · 第 2 版`、`技能 audit-notes · 第 1 版`，都链到团队约定页（点开能到模板页） |
| `12`–`14-手机宽度-…` | 390px 宽下约定首页、模板页、任务页都没有横向滚动（脚本比较 `documentElement.scrollWidth` 和 `window.innerWidth`，都是 390） |
