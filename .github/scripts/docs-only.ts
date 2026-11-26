// 判断一个 PR 是不是「纯文档」：是的话，CI 只真正跑 gitleaks 和 pr-checklist，其余重的检查按同样的名字报告为跳过（没有失败）。
// 纯文档 = 改动的每个文件（删除、重命名的新旧路径都算）都在 docs/ 下或者是根目录的 *.md，但下面两种不算：
//   - docs/deploy.md：tests/image-probe.test.ts 核对它和依赖探针的清单一致，改它要跑测试；
//   - src/ 下的 md（提示词、技能）：在 src/ 下，本来就不符合。
// 只要有一个文件不符合就跑全套。工作流从 base（合并提交的第一个父提交）取这个脚本来跑，PR 改它改变不了自己的判断结果；
// 改它的 PR 也改了 .github/，本来就不是纯文档。
// 用法（工作流里）：node <base 上的这个脚本>，在 PR 的合并提交里运行，输出 docs_only=true 或 docs_only=false（写进 $GITHUB_OUTPUT）。
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** 这个路径改了也不用跑重的检查 */
export function isDocPath(path: string): boolean {
  if (path === 'docs/deploy.md') return false
  if (path.startsWith('docs/')) return true
  return !path.includes('/') && path.endsWith('.md')
}

/** git diff --name-status --no-renames -z 的输出（状态、路径交替，NUL 分隔）里的全部路径；格式不对就报错 */
export function changedPaths(nameStatusZ: string): string[] {
  const parts = nameStatusZ.split('\0')
  if (parts.at(-1) === '') parts.pop()
  if (parts.length % 2 !== 0) throw new Error('git diff --name-status -z 的输出格式不对')
  const paths: string[] = []
  for (let i = 0; i < parts.length; i += 2) {
    if (!/^[ACDMRTUX]\d*$/.test(parts[i]!)) throw new Error(`认不出的改动状态：${parts[i]}`)
    paths.push(parts[i + 1]!)
  }
  return paths
}

/** 没有改动（空的合并提交之类）不算纯文档：照跑全套 */
export function isDocsOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every(isDocPath)
}

if (import.meta.main) {
  // --no-renames：重命名拆成删除旧路径和新增新路径，两个都要符合
  const out = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD^1', 'HEAD'], { encoding: 'utf8' })
  const paths = changedPaths(out)
  const docsOnly = isDocsOnly(paths)
  const outside = paths.filter(p => !isDocPath(p))
  console.log(docsOnly ? `纯文档 PR（${paths.length} 个文件），跳过重的检查` : `不是纯文档 PR，跑全套。不是文档的文件：${outside.slice(0, 10).join('、') || '（没有改动）'}`)
  const file = process.env.GITHUB_OUTPUT
  if (file !== undefined) appendFileSync(file, `docs_only=${docsOnly}\n`)
}
