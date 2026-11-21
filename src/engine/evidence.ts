// 改进提案的证据：从任务日志里用程序归纳出"哪里出了问题"，并归到涉及的团队约定（模板、技能、约定文档、工作流）上。
// 纯函数，只读任务日志。证据都是引擎已经判断过的事实（评审结论、检查结果、重新确认……），不再问模型。
//
// 每条证据有稳定、唯一的 id：任务:日志下标；检查失败再带 :第几条，越界撤销带 :r（同一次调用可能既有评审意见又有撤销）。
// 改进提案引用 id，平台据此核对提案的依据是否真实存在。
// 被评判的角色：评审意见、对话里的检查失败和打满轮次算到被评审方（对话 with 节点的角色），agent 节点的检查失败算到这个节点的角色；
// 流程走到尽头问用户：上游重新确认后决定问用户的算到上游的角色，其余（补齐用完、对话轮次用完）按所在节点算；
// 格式重试算到给出这个回复的角色，越界撤销算到这次调用的角色；调用失败不归到角色。
// agent 在调用中途主动提问是正常的澄清，不算证据。
import type { NodeId, RoleId, Workflow, WorkflowNode } from '../workflow/types.ts'
import { describeCheck } from './checks.ts'
import { CALL_FAILED_PREFIX, escalationNote, REVERTED_NOTE_PREFIX } from './machine.ts'
import type { Entry, Task } from './types.ts'
import { describeVerdict, parseDecision, parseVerdict } from './verdict.ts'

export const SIGNAL_KINDS = ['review_changes', 'check_failed', 'format_retry', 'escalated', 'stuck', 'scope_reverted', 'call_failed'] as const
export type SignalKind = (typeof SIGNAL_KINDS)[number]

export const TARGET_KINDS = ['template', 'skill', 'doc', 'workflow'] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

export type Signal = {
  id: string
  task: string
  /** 在任务日志里的下标。 */
  entry: number
  at: number
  kind: SignalKind
  node?: string
  /** 被评判的角色（工作流里的角色 id）。 */
  role?: string
  text: string
}

/** 任务用到的约定版本：和任务元数据里的 conventions 同形（只取用得到的字段）。没有时版本记为未知。 */
export type VersionsUsed = { workflow?: { version?: number }; skills?: { name: string; version: number }[] }

export type EvidenceSample = { task: Task; used?: VersionsUsed }

export type TargetEvidence = {
  kind: TargetKind
  name: string
  /** 这些任务用到的版本（已知的），从小到大。 */
  versions: number[]
  /** 用到这个约定的任务数（包括没有出问题的）。 */
  tasks: number
  /** 其中有证据的任务数。 */
  affected: number
  counts: Partial<Record<SignalKind, number>>
  /** 归到这个约定的证据 id，按任务和日志顺序。 */
  signals: string[]
}

export type Evidence = { signals: Signal[]; targets: TargetEvidence[] }

/** 单条证据文字的最大长度；更长的保留开头和结尾。 */
export const SIGNAL_TEXT_MAX = 1200

export const clipText = (s: string, max = SIGNAL_TEXT_MAX): string => {
  const t = s.trim()
  if (t.length <= max) return t
  const half = Math.floor((max - 20) / 2)
  if (half < 1) return t.slice(0, max)
  return `${t.slice(0, half)}\n…（省略 ${t.length - half * 2} 字）…\n${t.slice(-half)}`
}

const nodeOf = (wf: Workflow, id: string | undefined): WorkflowNode | undefined => (id === undefined ? undefined : wf.nodes.find(n => n.id === id))

/** 这个节点上被评判的角色：agent 节点是它自己的角色，对话节点是被评审方（with 节点）的角色。 */
const subjectOf = (wf: Workflow, id: string | undefined): RoleId | undefined => {
  const n = nodeOf(wf, id)
  if (n === undefined) return undefined
  if (n.kind === 'agent') return n.role
  const w = nodeOf(wf, n.with)
  return w?.kind === 'agent' ? w.role : undefined
}

/** 一个任务的全部证据，按日志顺序。 */
export const signalsOf = (task: Task): Signal[] => {
  const out: Signal[] = []
  const add = (entry: number, e: Entry, s: { kind: SignalKind; node?: NodeId | string; role?: RoleId | string; text: string }, sub?: number | 'r') => {
    out.push({
      id: sub === undefined ? `${task.id}:${entry}` : `${task.id}:${entry}:${sub}`, task: task.id, entry, at: e.at, kind: s.kind,
      ...(s.node === undefined ? {} : { node: s.node }), ...(s.role === undefined ? {} : { role: s.role }), text: clipText(s.text),
    })
  }
  task.log.forEach((e, i) => {
    switch (e.type) {
      case 'call': {
        if (e.purpose === 'critique') {
          const v = parseVerdict(e.reply)
          if (v === undefined) add(i, e, { kind: 'format_retry', node: e.node, role: e.role, text: `评审结论无法解析：${e.reply}` })
          else if (v.verdict === 'changes') add(i, e, { kind: 'review_changes', node: e.node, role: subjectOf(task.workflow, e.node), text: describeVerdict(v) })
        } else if (e.purpose === 'reconfirm' && parseDecision(e.reply) === undefined) {
          add(i, e, { kind: 'format_retry', node: e.node, role: e.role, text: `重新确认的回复无法解析：${e.reply}` })
        }
        if (e.reverted !== undefined && e.reverted.length > 0) {
          add(i, e, { kind: 'scope_reverted', node: e.node, role: e.role, text: `越界改动被撤销：${e.reverted.join('、')}` }, 'r')
        }
        return
      }
      case 'check': {
        const role = subjectOf(task.workflow, e.node)
        e.results.forEach((r, k) => {
          if (!r.passed) add(i, e, { kind: 'check_failed', node: e.node, role, text: `${describeCheck(r.check)}：没有通过${r.detail.trim() === '' ? '' : `\n${r.detail}`}` }, k)
        })
        return
      }
      case 'question': {
        if (e.question.source !== 'loop') return
        // 紧跟在上游重新确认的回复之后：是上游决定问用户（中间可能隔着这次调用的越界撤销说明）。
        const prev = task.log.slice(0, i).findLast(x => !(x.type === 'note' && x.text.startsWith(REVERTED_NOTE_PREFIX)))
        const role = prev?.type === 'call' && prev.purpose === 'reconfirm' ? prev.role : subjectOf(task.workflow, e.question.node)
        add(i, e, { kind: 'stuck', node: e.question.node, role, text: e.question.text })
        return
      }
      case 'note': {
        const n = nodeOf(task.workflow, e.node)
        if (n?.kind === 'dialog' && n.escalate !== undefined && e.text === escalationNote(n.maxRounds, n.escalate)) {
          add(i, e, { kind: 'escalated', node: e.node, role: subjectOf(task.workflow, e.node), text: e.text })
        } else if (e.text.startsWith(CALL_FAILED_PREFIX)) add(i, e, { kind: 'call_failed', node: e.node, text: e.text })
        return
      }
      case 'answer':
        return
    }
  })
  return out
}

type Ref = { kind: TargetKind; name: string; version?: number }
const key = (r: { kind: TargetKind; name: string }) => `${r.kind}\u0000${r.name}`

/** 任务用到的约定：工作流、约定文档，以及每个角色的模板和技能。 */
const refsOf = (s: EvidenceSample): { all: Ref[]; byRole: Map<string, Ref[]> } => {
  const t = s.task
  const skillVersion = new Map((s.used?.skills ?? []).map(k => [k.name, k.version]))
  const byRole = new Map(Object.entries(t.workflow.roles).map(([id, r]) => [id, [
    ...(r.template === undefined ? [] : [{ kind: 'template' as const, name: r.template.name, version: r.template.version }]),
    ...r.skills.map(name => ({ kind: 'skill' as const, name, ...(skillVersion.has(name) ? { version: skillVersion.get(name)! } : {}) })),
  ]]))
  const shared: Ref[] = [
    { kind: 'workflow', name: t.workflow.name, ...(s.used?.workflow?.version === undefined ? {} : { version: s.used.workflow.version }) },
    ...t.docs.map(d => ({ kind: 'doc' as const, name: d.name, version: d.version })),
  ]
  return { all: [...shared, ...[...byRole.values()].flat()], byRole: new Map([...byRole].map(([id, rs]) => [id, [...shared, ...rs]])) }
}

/** 按码点比较：排序结果不依赖运行环境的 locale。 */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 跨任务的证据，按约定汇总。约定按证据条数从多到少排，同样多时按种类（模板、技能、文档、工作流）和名字。同一个任务不能出现两次（证据 id 会重复）。 */
export const evidence = (samples: EvidenceSample[]): Evidence => {
  const ids = samples.map(s => s.task.id)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup !== undefined) throw new Error(`任务 ${dup} 出现了两次`)
  const signals: Signal[] = []
  const targets = new Map<string, { kind: TargetKind; name: string; versions: Set<number>; tasks: Set<string>; affected: Set<string>; signals: Signal[] }>()
  const target = (r: Ref) => {
    const k = key(r)
    let t = targets.get(k)
    if (t === undefined) targets.set(k, t = { kind: r.kind, name: r.name, versions: new Set(), tasks: new Set(), affected: new Set(), signals: [] })
    return t
  }
  for (const s of samples) {
    const refs = refsOf(s)
    for (const r of refs.all) {
      const t = target(r)
      t.tasks.add(s.task.id)
      if (r.version !== undefined) t.versions.add(r.version)
    }
    const shared = refs.all.filter(r => r.kind === 'workflow' || r.kind === 'doc')
    for (const sig of signalsOf(s.task)) {
      signals.push(sig)
      // 同一个约定被一个角色以多种方式用到（例如技能重复）时只记一次。
      const seen = new Set<string>()
      for (const r of sig.role === undefined ? shared : refs.byRole.get(sig.role) ?? shared) {
        if (seen.has(key(r))) continue
        seen.add(key(r))
        const t = target(r)
        t.signals.push(sig)
        t.affected.add(s.task.id)
      }
    }
  }
  const order = (k: TargetKind) => TARGET_KINDS.indexOf(k)
  return {
    signals,
    targets: [...targets.values()].map(t => ({
      kind: t.kind, name: t.name, versions: [...t.versions].sort((a, b) => a - b), tasks: t.tasks.size, affected: t.affected.size,
      counts: Object.fromEntries(SIGNAL_KINDS.flatMap(k => {
        const n = t.signals.filter(x => x.kind === k).length
        return n === 0 ? [] : [[k, n]]
      })),
      signals: t.signals.map(x => x.id),
    })).sort((a, b) => b.signals.length - a.signals.length || order(a.kind) - order(b.kind) || byCodePoint(a.name, b.name)),
  }
}
