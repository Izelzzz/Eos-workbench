// 改进相关的中文名称：命令行、提示词和网页共用。没有依赖，前端可以直接引用。
import type { SignalKind, TargetKind } from '../engine/evidence.ts'
import type { ProposalStatus } from '../store/types.ts'

export const SIGNAL_NAMES: Record<SignalKind, string> = {
  review_changes: '评审要求修改',
  check_failed: '检查没通过',
  format_retry: '回复格式无法解析',
  escalated: '打满轮次，请上游重新确认',
  stuck: '走到尽头，问用户',
  scope_reverted: '越界改动被撤销',
  call_failed: '调用失败',
}
export const TARGET_NAMES: Record<TargetKind, string> = { template: 'Agent 模板', skill: '技能', doc: '约定文档', workflow: '工作流' }
export const KIND_NAMES = { workflow: '工作流', doc: '约定文档', template: 'Agent 模板', skill: '技能' } as const
export const STATUS_NAMES: Record<ProposalStatus, string> = { pending: '待审批', approved: '已批准', rejected: '已拒绝', stale: '已过期' }
