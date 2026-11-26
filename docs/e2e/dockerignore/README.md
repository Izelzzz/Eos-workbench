# `.dockerignore` 改为任意层级匹配：本地构建验证

不调用模型。用来支撑 PR 描述里「端到端验证」的豁免理由。

## 背景

Docker 的 `.dockerignore` 模式只从构建上下文的根目录开始匹配，原来的 `node_modules` 只排除根目录那一份。开发机装过 lint 依赖（`.github/lint/node_modules`）时，`COPY . .` 会把它带进镜像（其中有 typescript 6.0.3），导致本地构建的镜像和 CI 的不一样。`.env`、`.env.*`、`*.log`、`.eos` 也有同样的问题。

## 环境

- 基线：main `f679c2a`，只改 `.dockerignore`
- 构建前先在 `.github/lint` 下跑 `npm ci`，让 `.github/lint/node_modules` 存在（复现问题的前提）
- 构建命令（容器里的代理要求加这两个参数，Dockerfile 本身不变）：
  `docker build --network host --secret id=extra_ca,src=<代理根证书> -t eos-dockerignore:<before|after> .`

## 结果

| 检查 | 改动前（`before`） | 改动后（`after`） |
|---|---|---|
| `/app/.github/lint/node_modules` | 存在，typescript 6.0.3 | 不存在 |
| `/app` 下 `node_modules` 目录（不含 `/app/node_modules`） | 有 | 没有 |
| `/app` 下的文件数（不含 `/app/node_modules`） | 2957 | 242 |
| 冒烟 `docker run --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges:true <镜像> eos --help` | — | 退出码 0，见 `smoke-eos-help.txt` |

- `app-files-diff.txt`：两个镜像 `/app` 文件清单的差别（不含 `/app/node_modules`）。只有 lint 的 node_modules（2693 个文件）和 `poc/claude-code/logs/**/*.log`（22 个）被去掉，没有新增的文件。2957 − 2693 − 22 = 242
- 改动后的镜像里 `/app/node_modules`（镜像里 `npm ci` 装的）、`/app/web/dist`、`/app/vendor/dsh-sdk-client`、`/app/src/workflow/docs/` 都还在
- `context-probe.txt`：在 `src/zz-probe/` 下临时放了 `.env`、`.env.local`、`x.log`、`.eos/a`、`node_modules/a`、`keep.txt`，用 `COPY . /ctx` 的探测构建列出构建上下文：只有 `keep.txt` 进去了，`src/workflow/docs/研发约定.md` 还在。探测之后这些文件已删掉
