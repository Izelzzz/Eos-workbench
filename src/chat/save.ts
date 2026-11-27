// 保存对话里的提议：唯一一条把 agent 的提议写成约定新版本的路径，只由人触发（命令行 eos chat save，之后的网页「保存」）。
// agent 能触发的模块（端点、工具、提议、对话流程）都不引用这个文件（tests/chat-proposals.test.ts 核对）。
// 保存前按现在的状态重新检查一遍：提议是在记下那一刻检查的，之后模板、技能、文档、目标约定都可能变了。
// - 作废的、已经保存过的不保存；
// - 目标约定的最新版本不是提议基于的版本（新建的：已经有人建了）就拒绝，判断和写入在同一个事务里；
// - 按保存约定时的规则重新检查；内容里有已知凭据值就拒绝；和当前版本一样就不保存；
// - 按现在的内容重算涉及的权限改动，有改动时必须明确确认（allowPermissions），否则拒绝并列出这些改动。
import type { Conventions } from '../conventions/conventions.ts'
import type { Store } from '../store/store.ts'
import { permissionsOf } from './proposals.ts'
import type { ChatStore } from './store.ts'
import type { ChatActor, ChatProposal } from './types.ts'

export type SaveOutcome =
  | { ok: true; version: number; proposal: ChatProposal; permissions: string[] }
  /** permissions：没带确认时，需要确认的那些权限改动。 */
  | { ok: false; error: string; permissions?: string[] }

const KIND_NAMES = { workflow: '工作流', template: 'Agent 模板' } as const

export const saveProposal = (o: {
  store: Store
  chats: ChatStore
  conventions: Conventions
  redact: (s: string) => string
  id: number
  actor: ChatActor
  /** 提议涉及权限改动时，人明确确认过（命令行的 --allow-permissions）。 */
  allowPermissions: boolean
  note?: string
  now: () => number
}): SaveOutcome => {
  const p = o.chats.proposal(o.id)
  if (p === undefined) return { ok: false, error: `没有提议 #${o.id}` }
  const what = `${KIND_NAMES[p.kind]}「${p.name}」`
  if (p.voided !== undefined) return { ok: false, error: `提议 #${p.id} 已作废，不能保存：${p.voided}` }
  if (p.saved !== undefined) return { ok: false, error: `提议 #${p.id} 已经保存过（${what}第 ${p.saved.version} 版）` }
  const current = o.store.convention(p.kind, p.name)
  if (current?.version !== p.baseVersion) return { ok: false, error: stale(p, current?.version) }
  if (current?.content === p.content) return { ok: false, error: `${what}的当前版本已经和这条提议一样，不需要保存` }
  if (o.redact(p.content) !== p.content) return { ok: false, error: '提议里有凭据值：约定以明文保存，不能保存' }
  const errors = o.conventions.validate(p.kind, p.name, p.content)
  if (errors.length > 0) return { ok: false, error: `${what}按现在的平台状态没有通过检查，不能保存：\n${errors.map(e => `- ${e.path}：${e.message}`).join('\n')}` }
  const permissions = permissionsOf(p.kind, p.name, current?.content, p.content, o.conventions.lookup())
  if (permissions.length > 0 && !o.allowPermissions) {
    return { ok: false, error: `提议 #${p.id} 涉及权限改动，要确认之后才能保存（命令行加 --allow-permissions）：\n${permissions.map(x => `- ${x}`).join('\n')}`, permissions }
  }
  const userNote = o.note?.trim() ?? ''
  const note = `来自对话 ${p.chatId} 的提议 #${p.id}${permissions.length > 0 ? '（确认了权限改动）' : ''}${userNote === '' ? '' : `：${userNote}`}`
  const at = o.now()
  const row = o.store.saveConventionIfLatest({ kind: p.kind, name: p.name, content: p.content, note, actor: o.actor }, p.baseVersion, at)
  if ('stale' in row) return { ok: false, error: stale(p, row.latest) }
  o.chats.markSaved(p.id, { version: row.version, actor: o.actor, at })
  return { ok: true, version: row.version, proposal: o.chats.proposal(p.id)!, permissions }
}

const stale = (p: ChatProposal, latest: number | undefined): string =>
  p.baseVersion === undefined
    ? `提议 #${p.id} 是新建「${p.name}」，但平台上已经有它的第 ${latest ?? '?'} 版了：请让 agent 基于现在的版本重新提议`
    : `提议 #${p.id} 基于第 ${p.baseVersion} 版，「${p.name}」现在是第 ${latest ?? '（已不存在）'} 版：请让 agent 基于现在的版本重新提议`
