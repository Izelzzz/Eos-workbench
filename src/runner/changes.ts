// 任务改动的数据形状和对 git diff 输出的纯处理。不做 IO，前端也引用这里的类型。

/** 任务分支上一个文件相对基线的改动。diff 不在列表里，点开时按文件单独取（见 FileDiff）。 */
export type FileChange = {
  path: string
  /** 改名前的路径（只有改名才有）。 */
  from?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  add: number
  del: number
  binary: boolean
}

/** 任务分支相对基线已提交的改动。head 是取列表时解析好的提交，取单个文件的 diff 时带上它，列表和 diff 对的是同一个提交。 */
export type TaskChanges = { base: string; head: string; files: FileChange[]; /** 超出 MAX_FILES 没列出的文件数。 */ omitted: number }

/** 一个文件的 diff，从第一个 @@ 开始。超过行数或字数上限时截断，记下原来的行数和字数。 */
export type FileDiff = { diff: string; truncated?: { lines: number; chars: number } }

export const MAX_FILES = 1000
export const MAX_DIFF_LINES = 2000
export const MAX_DIFF_CHARS = 200_000

/**
 * git diff 的原始输出 → 只留 @@ 段。一个文件也可能有好几段（例如普通文件换成符号链接，git 输出删除加新增），
 * 每段前面的 diff --git、index、---/+++、mode 等头部行都去掉，免得被当成增删的代码。
 */
export const hunks = (raw: string): string => {
  const out: string[] = []
  let header = true
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) header = true
    else if (line.startsWith('@@')) header = false
    if (!header) out.push(line)
  }
  while (out.length > 0 && out.at(-1) === '') out.pop()
  return out.join('\n')
}

export const truncate = (text: string): FileDiff => {
  const lines = text === '' ? [] : text.split('\n')
  if (lines.length <= MAX_DIFF_LINES && text.length <= MAX_DIFF_CHARS) return { diff: text }
  let kept = lines.slice(0, MAX_DIFF_LINES).join('\n')
  if (kept.length > MAX_DIFF_CHARS) kept = kept.slice(0, MAX_DIFF_CHARS)
  return { diff: kept, truncated: { lines: lines.length, chars: text.length } }
}
