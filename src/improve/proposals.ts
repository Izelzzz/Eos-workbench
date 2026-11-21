// 改进提案：入库前校验，审批（批准写回约定的新版本 / 拒绝 / 过期）。提案只追加状态，没有批准就不改任何约定（ADR-004）。
import type { Conventions } from '../conventions/conventions.ts'
import { permissionChanges } from './guard.ts'
import { KIND_NAMES, STATUS_NAMES } from './labels.ts'
import type { Store } from '../store/store.ts'
import type { Decision, ProposalInput, ProposalRow } from '../store/types.ts'

export type AddResult = { ok: true; row: ProposalRow } | { ok: false; errors: string[] }
export type DecideResult = { ok: true; row: ProposalRow } | { ok: false; error: string; row?: ProposalRow }

/** 写进约定新版本备注里的理由摘要的最大长度。 */
const NOTE_MAX = 80

const oneLine = (s: string, max: number): string => {
  const t = [...s.trim().split('\n')[0]!.trim()]
  return t.length <= max ? t.join('') : `${t.slice(0, max - 1).join('')}…`
}

export class Proposals {
  constructor(private readonly store: Store, private readonly conventions: Conventions) {}

  /** 校验并入库。不合格的不入库，返回全部原因。 */
  add(p: ProposalInput, at: number): AddResult {
    const errors = this.check(p)
    return errors.length > 0 ? { ok: false, errors } : { ok: true, row: this.store.addProposal(p, at) }
  }

  /** 入库前的校验：目标存在、基于最新版本、内容有变化并能通过这类约定的保存校验、有理由和证据。 */
  check(p: ProposalInput): string[] {
    const errors: string[] = []
    const { kind, name } = p.target
    const latest = this.store.convention(kind, name)
    if (latest === undefined) return [`平台上没有${KIND_NAMES[kind]}「${name}」`]
    if (p.baseVersion !== latest.version) errors.push(`提案基于第 ${p.baseVersion} 版，${KIND_NAMES[kind]}「${name}」现在是第 ${latest.version} 版`)
    if (p.content === latest.content) errors.push('新内容和当前版本完全一样')
    else errors.push(...this.conventions.validate(kind, name, p.content).map(e => `新内容不合格：${e.path}：${e.message}`))
    if (p.rationale.trim() === '') errors.push('缺少理由')
    if (p.evidence.length === 0) errors.push('没有引用任何证据')
    return errors
  }

  /**
   * 批准：在一个事务里先核对版本（过期就记下），再用约定的保存校验再校验一次（提案之后被引用的模板、文档可能变了），
   * 不合格就不批准、保持待审批，由审批的人拒绝；都通过才写入新版本（见 Store.decideProposal）。
   */
  approve(id: number, at: number, actor: string, note = ''): DecideResult {
    const extra = note.trim()
    const d = this.store.decideProposal(id, {
      status: 'approved',
      reason: extra,
      note: row => `改进提案 #${row.id}：${oneLine(row.rationale, NOTE_MAX)}${extra === '' ? '' : `；${extra}`}`,
      // 批准时再核对一次权限（失败就关）：生成之后，工作流引用的模板可能被人改过，同一份内容展开出来的权限会变。
      validate: row => [
        ...this.conventions.validate(row.target.kind, row.target.name, row.content).map(e => `${e.path}：${e.message}`),
        ...permissionChanges(row.target.kind, this.store.convention(row.target.kind, row.target.name, row.baseVersion)!.content, row.content, this.conventions.lookup()),
      ],
    }, at, actor)
    return d.ok ? d : { ok: false, error: describe(id, d), ...(d.row === undefined ? {} : { row: d.row }) }
  }

  /** 拒绝：必须写理由。 */
  reject(id: number, at: number, actor: string, reason: string): DecideResult {
    if (reason.trim() === '') return { ok: false, error: '拒绝需要写理由' }
    const d = this.store.decideProposal(id, { status: 'rejected', reason: reason.trim() }, at, actor)
    return d.ok ? d : { ok: false, error: describe(id, d), ...(d.row === undefined ? {} : { row: d.row }) }
  }
}

export { KIND_NAMES, STATUS_NAMES } from './labels.ts'

const describe = (id: number, d: Exclude<Decision, { ok: true }>): string => {
  switch (d.reason) {
    case 'missing': return `没有提案 #${id}`
    case 'not_pending': return `提案 #${id} ${STATUS_NAMES[d.row!.status]}，不能再审批`
    case 'stale': return `提案 #${id} 已过期：${d.row!.events.at(-1)!.reason}。请重新生成提案`
    case 'invalid': return `新内容现在不能批准：${d.errors.join('；')}`
  }
}
