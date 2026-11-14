// 「所有会话」：解析 claude-code-remote 的 list_sessions 结果，按需要你介入的紧迫程度排序。纯函数。
import type { SessionBucket, SessionItem } from '../../types'

/** 面板和文字输出里各分组的顺序与标题。 */
export const BUCKETS: readonly { bucket: SessionBucket; label: string; icon: string }[] = [
  { bucket: 'blocked', label: '等你决定', icon: '🔴' },
  { bucket: 'working', label: '进行中', icon: '🟢' },
  { bucket: 'review_ready', label: '可以审查', icon: '🟡' },
  { bucket: 'failed', label: '失败', icon: '✕' },
  { bucket: 'completed', label: '已完成', icon: '✅' },
  { bucket: 'unknown', label: '其他', icon: '·' },
]

const KNOWN: readonly SessionBucket[] = ['blocked', 'working', 'review_ready', 'failed', 'completed']

const toBucket = (raw: unknown): SessionBucket => {
  const name = String(raw ?? '').replace(/^SESSION_STATUS_BUCKET_/, '').toLowerCase() as SessionBucket
  return KNOWN.includes(name) ? name : 'unknown'
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

export type ParsedSessions = { items: SessionItem[]; hasMore: boolean }

/**
 * list_sessions 的文本结果：JSON 外面包着一层"其他会话的数据"标记，先把 JSON 取出来。
 * 归档的会话不列出。解析不了时抛错，由调用方显示原因。
 */
export const parseSessionList = (raw: string): ParsedSessions => {
  const start = raw.indexOf('{')
  const close = raw.lastIndexOf('</other-session')
  const end = raw.lastIndexOf('}', close < 0 ? raw.length : close)
  if (start < 0 || end <= start) throw new Error('会话列表不是 JSON')
  const json = JSON.parse(raw.slice(start, end + 1)) as { ccr?: { data?: unknown[]; has_more?: boolean }; data?: unknown[]; has_more?: boolean }
  const body = json.ccr ?? json
  const rows = Array.isArray(body.data) ? body.data : []
  const items: SessionItem[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || r.session_status === 'SESSION_STATUS_ARCHIVED') continue
    const summary = (typeof r.post_turn_summary === 'object' && r.post_turn_summary !== null ? r.post_turn_summary : {}) as Record<string, unknown>
    const updated = Date.parse(String(r.updated_at ?? r.created_at ?? ''))
    items.push({
      id: r.id,
      title: text(r.title) ?? '（无标题）',
      bucket: toBucket(r.status_bucket),
      updatedAt: Number.isNaN(updated) ? 0 : updated,
      needsAction: text(summary.needs_action),
      recentAction: text(summary.recent_action),
      unread: r.unread === true ? true : undefined,
      origin: text(r.origin),
    })
  }
  return { items: sortSessions(items), hasMore: body.has_more === true }
}

/** 先按分组顺序，组内最近更新的在前。 */
export const sortSessions = (items: readonly SessionItem[]): SessionItem[] => {
  const rank = (b: SessionBucket) => BUCKETS.findIndex(x => x.bucket === b)
  return [...items].sort((a, b) => rank(a.bucket) - rank(b.bucket) || b.updatedAt - a.updatedAt)
}

/** 云端会话 ID 的前缀不统一（cse_… / session_…），比较时去掉前缀。 */
export const sameSession = (a: string | undefined, b: string | undefined): boolean => {
  const core = (id: string) => id.replace(/^[a-z]+_/, '')
  return a !== undefined && b !== undefined && core(a) === core(b)
}

export const sessionUrl = (id: string): string => `https://claude.ai/code/${id}`

export const formatAgo = (ms: number, now: number): string => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}

/** 一条会话下面那一行：等你决定的显示要你做什么，其余显示最近一步。 */
export const sessionDetail = (item: SessionItem): string | undefined =>
  item.bucket === 'blocked' ? (item.needsAction ?? item.recentAction) : (item.recentAction ?? item.needsAction)

/** 文字版（命令输出），已完成的只列最近 completedLimit 个。 */
export const formatSessions = (p: { items: readonly SessionItem[]; now: number; currentId?: string; hasMore: boolean; completedLimit?: number }): string => {
  const lines: string[] = []
  for (const { bucket, label, icon } of BUCKETS) {
    let group = p.items.filter(i => i.bucket === bucket)
    if (group.length === 0) continue
    const total = group.length
    if (bucket === 'completed') group = group.slice(0, p.completedLimit ?? 5)
    lines.push(`${icon} ${label}（${total}）`)
    for (const item of group) {
      const mark = sameSession(item.id, p.currentId) ? '（当前会话）' : ''
      lines.push(`  ${item.title}${mark} · ${formatAgo(item.updatedAt, p.now)}`)
      const detail = sessionDetail(item)
      if (detail !== undefined) lines.push(`    ${detail}`)
      lines.push(`    ${sessionUrl(item.id)}`)
    }
    if (group.length < total) lines.push(`  …另有 ${total - group.length} 个已完成`)
    lines.push('')
  }
  if (lines.length === 0) return '没有会话。'
  if (p.hasMore) lines.push('（只列出了最近的会话）')
  return lines.join('\n').trimEnd()
}
