// 路径 glob 匹配：纯函数，给角色的可写范围（writePaths）判断一处改动是否越界。
// 语义按路径段（/）划分：** 匹配零个或多个段；* 和 ? 只在一个段内匹配，* 匹配任意多个字符，? 匹配一个字符。
// 例：src/** 匹配 src、src/a.ts、src/a/b.ts；*.md 只匹配根目录下的 md 文件；**/*.md 匹配任意层级的 md 文件。

/** 一个段内的匹配：* 任意多个字符，? 一个字符，其余按字面。 */
const matchSegment = (pattern: string, s: string): boolean => {
  if (pattern === '') return s === ''
  const head = pattern[0]!
  if (head === '*') {
    for (let i = 0; i <= s.length; i++) if (matchSegment(pattern.slice(1), s.slice(i))) return true
    return false
  }
  if (s === '') return false
  if (head === '?') return matchSegment(pattern.slice(1), s.slice(1))
  return head === s[0] && matchSegment(pattern.slice(1), s.slice(1))
}

const matchSegments = (pattern: string[], segments: string[]): boolean => {
  if (pattern.length === 0) return segments.length === 0
  const [head, ...rest] = pattern as [string, ...string[]]
  if (head === '**') {
    for (let i = 0; i <= segments.length; i++) if (matchSegments(rest, segments.slice(i))) return true
    return false
  }
  if (segments.length === 0) return false
  return matchSegment(head, segments[0]!) && matchSegments(rest, segments.slice(1))
}

/** 去掉开头的 ./、结尾的 /（目录写法等价于它下面的全部内容）和空段。 */
const segmentsOf = (path: string): string[] => path.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.')

const patternSegments = (pattern: string): string[] => {
  const segments = segmentsOf(pattern)
  return pattern.replace(/\\/g, '/').endsWith('/') ? [...segments, '**'] : segments
}

/** 这个 glob 是否匹配这条（worktree 内的相对）路径。 */
export const matchGlob = (pattern: string, path: string): boolean =>
  matchSegments(patternSegments(pattern), segmentsOf(path))

/** 这条路径是否被其中任意一个 glob 允许；patterns 为空表示什么都不允许。 */
export const matchesAny = (patterns: string[], path: string): boolean => patterns.some(p => matchGlob(p, path))
