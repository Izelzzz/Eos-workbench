// 保存对话里的提议：唯一一条把 agent 的提议写成约定新版本的路径，只由人触发（命令行 eos chat save，之后的网页「保存」）。
// agent 能触发的模块（端点、工具、提议、对话流程、存储）都不引用这个文件（tests/chat-save.test.ts 核对）。
// 保存前按现在的状态重新检查一遍：提议是在记下那一刻检查的，之后模板、技能、文档、目标约定都可能变了。
// - 作废的、已经保存过的不保存；
// - 目标约定的最新版本不是提议基于的版本（新建的：已经有人建了）就拒绝；
// - 按保存约定时的规则重新检查；内容里有已知凭据值就拒绝；和当前版本一样就不保存；
// - 按现在的状态重算涉及的权限改动。有改动时要带确认码：它是这份改动清单的摘要（eos chat show 显示），
//   清单在看过之后又变了，确认码就对不上，保存被拒绝并列出新的清单。人确认的就是他看到的那份。
// 写入新版本和记下提议已保存在同一个事务里，核对版本也在这个事务里：要么都写，要么都不写。
import { createHash } from 'node:crypto'
import type { Conventions } from '../conventions/conventions.ts'
import type { Store } from '../store/store.ts'
import { permissionsOf } from './proposals.ts'
import type { ChatStore } from './store.ts'
import type { ChatActor, ChatProposal } from './types.ts'

export type SaveOutcome =
  | { ok: true; version: number; proposal: ChatProposal; permissions: string[] }
  /** permissions、code：需要确认的那些权限改动和它们的确认码（没带或带错了确认码时）。 */
  | { ok: false; error: string; permissions?: string[]; code?: string }

const KIND_NAMES = { workflow: '工作流', template: 'Agent 模板' } as const

/** 一份权限改动清单的确认码：清单变了，确认码就变。 */
export const confirmationCode = (permissions: string[]): string => createHash('sha256').update(JSON.stringify(permissions)).digest('hex').slice(0, 8)

/** 按现在的平台状态，这条提议涉及的权限改动（eos chat show 和保存用同一个算法、同一个时刻的状态）。 */
export const currentPermissions = (p: ChatProposal, store: Store, conventions: Conventions): string[] =>
  permissionsOf(p.kind, p.name, store.convention(p.kind, p.name)?.content, p.content, conventions.lookup())

export const saveProposal = (o: {
  store: Store
  chats: ChatStore
  conventions: Conventions
  redact: (s: string) => string
  id: number
  actor: ChatActor
  /** 人确认过的权限改动的确认码（命令行的 --allow-permissions <确认码>）。 */
  confirm?: string
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
  const permissions = currentPermissions(p, o.store, o.conventions)
  if (permissions.length > 0) {
    const code = confirmationCode(permissions)
    if (o.confirm !== code) {
      const why = o.confirm === undefined ? '涉及权限改动，要确认之后才能保存' : '涉及的权限改动和确认码对不上（你看过之后平台状态变了），请看过下面这份再确认'
      return { ok: false, error: `提议 #${p.id} ${why}（命令行加 --allow-permissions ${code}）：\n${permissions.map(x => `- ${x}`).join('\n')}`, permissions, code }
    }
  }
  const userNote = o.note?.trim() ?? ''
  const note = `来自对话 ${p.chatId} 的提议 #${p.id}${permissions.length > 0 ? '（确认了权限改动）' : ''}${userNote === '' ? '' : `：${userNote}`}`
  const at = o.now()
  let row
  try {
    row = o.store.saveConventionIfLatest({ kind: p.kind, name: p.name, content: p.content, note, actor: o.actor }, p.baseVersion, at, saved => {
      // 同一个事务里记下提议已保存；没记上（被别的进程抢先保存了）就整个回滚。
      if (!o.chats.markSaved(p.id, { version: saved.version, actor: o.actor, at })) throw new AlreadySaved()
    })
  } catch (e) {
    if (e instanceof AlreadySaved) return { ok: false, error: `提议 #${p.id} 刚刚被别处保存过了` }
    throw e
  }
  if ('stale' in row) return { ok: false, error: stale(p, row.latest) }
  return { ok: true, version: row.version, proposal: o.chats.proposal(p.id)!, permissions }
}

class AlreadySaved extends Error {}

const stale = (p: ChatProposal, latest: number | undefined): string =>
  p.baseVersion === undefined
    ? `提议 #${p.id} 是新建「${p.name}」，但平台上已经有它的第 ${latest ?? '?'} 版了：请让 agent 基于现在的版本重新提议`
    : `提议 #${p.id} 基于第 ${p.baseVersion} 版，「${p.name}」现在是第 ${latest ?? '（已不存在）'} 版：请让 agent 基于现在的版本重新提议`
