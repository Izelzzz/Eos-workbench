import type { SpanKind, SpanStatus } from './api.ts'

export const duration = (ms: number | undefined): string => {
  if (ms === undefined || !Number.isFinite(ms)) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export const tokens = (n: number | undefined): string => {
  if (n === undefined) return ''
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US')
}

export const clock = (t: number): string => (t > 0 ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '')

export const ago = (t: number): string => {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.round(s / 3600)} 小时前`
  return new Date(t).toLocaleDateString('zh-CN')
}

export const STATUS: Record<string, string> = {
  running: '运行中',
  waiting_user: '等待回答',
  done: '已完成',
  failed: '失败',
  aborted: '已中止',
  ok: '完成',
  error: '出错',
  waiting: '等待回答',
  pending: '未开始',
}

export const statusClass = (s: SpanStatus | string): string =>
  ({ done: 'ok', ok: 'ok', running: 'running', waiting_user: 'waiting', waiting: 'waiting', failed: 'error', error: 'error', aborted: 'error', pending: 'pending' })[s] ?? 'pending'

export const KIND: Record<SpanKind, string> = {
  task: '任务',
  node: '节点',
  call: '调用',
  check: '检查',
  model: '模型',
  tool: '工具',
  question: '提问',
  answer: '回答',
  note: '说明',
}
