// 每种调用用途的提示词。纯函数：只读任务状态，不做 IO。
import type { DialogNode, NodeId, Workflow, WorkflowNode } from '../workflow/types.ts'
import { node as nodeOf, role as roleOf } from '../workflow/types.ts'
import type { Task } from './types.ts'

export const VERDICT_FORMAT = `最终回复只包含一个 JSON 代码块，格式如下：
\`\`\`json
{"verdict": "pass 或 changes", "summary": "一两句话总结", "issues": [{"severity": "blocker、major 或 minor", "file": "路径（可选）", "message": "问题与修改建议"}]}
\`\`\`
存在 blocker 或 major 问题时 verdict 必须是 changes；只有 minor 时可以是 pass。`

export const DECISION_FORMAT = `最终回复只包含一个 JSON 代码块，二选一：
\`\`\`json
{"decision": "revise", "plan": "修订后的完整方案（Markdown）"}
\`\`\`
或
\`\`\`json
{"decision": "ask_user", "question": "需要用户决定的具体问题"}
\`\`\``

const section = (title: string, body: string | undefined) => (body === undefined || body.trim() === '' ? '' : `# ${title}\n\n${body.trim()}\n\n`)

/** 会话的第一条消息带上角色说明；之后同一会话里不再重复。 */
const intro = (task: Task, session: NodeId, wf: Workflow, n: WorkflowNode): string =>
  task.sessions[session] === undefined ? section('你的角色', roleOf(wf, n.role).prompt) : ''

const context = (task: Task, n: WorkflowNode): string =>
  section('需求', task.request) + section('环境', task.context) + n.inputs.map(i => section(`上游产出：${i}`, task.outputs[i])).join('')

export const producePrompt = (task: Task, n: WorkflowNode): string =>
  `${intro(task, n.id, task.workflow, n)}${section('任务', n.task)}${context(task, n)}完成后，你的最终回复就是这一步的产出。`

export const critiquePrompt = (task: Task, d: DialogNode, kind: 'first' | 'reply' | 'revised' | 'format', reply?: string): string => {
  const head = intro(task, d.id, task.workflow, d)
  const round = task.dialog?.round ?? 1
  switch (kind) {
    case 'first':
      return `${head}${section('任务', d.task)}${context(task, d)}${section(`待评审：${d.with} 的说明`, task.outputs[d.with])}${VERDICT_FORMAT}`
    case 'reply':
      return `${head}${section(`第 ${round} 轮：${d.with} 的回复`, reply)}请复核最新改动（git diff）后重新给出结论。\n\n${VERDICT_FORMAT}`
    case 'revised':
      return `${head}${section('方案已重新确认', d.escalate === undefined ? undefined : task.outputs[d.escalate])}${section(`${d.with} 按新方案调整后的回复`, reply)}请按新方案重新评审，从第 1 轮重新开始。\n\n${VERDICT_FORMAT}`
    case 'format':
      return `${head}你上一条回复无法解析成结论。\n\n${VERDICT_FORMAT}`
  }
}

export const respondPrompt = (task: Task, d: DialogNode, critique: string): string => {
  const target = nodeOf(task.workflow, d.with)
  return `${intro(task, d.with, task.workflow, target)}${section(`评审意见（第 ${task.dialog?.round ?? 1} 轮）`, critique)}逐条处理：修改、回答问题，或带着理由反驳。最后简要说明你做了什么。`
}

export const reconfirmPrompt = (task: Task, d: DialogNode, input: { stuck: true } | { instruction: string } | { format: true }): string => {
  const up = nodeOf(task.workflow, d.escalate!)
  const head = intro(task, up.id, task.workflow, up)
  if ('format' in input) return `${head}你上一条回复无法解析。\n\n${DECISION_FORMAT}`
  if ('instruction' in input) return `${head}${section('用户的指示', input.instruction)}请据此输出修订后的完整方案；如果仍需用户决定，提出具体问题。\n\n${DECISION_FORMAT}`
  const stuck = `「${d.with}」和评审「${d.id}」对话 ${d.maxRounds} 轮仍未通过。`
  return `${head}${section('需要你重新确认做法与需求', stuck)}${section('最新评审意见', task.dialog?.lastCritique)}${section(`${d.with} 最后的回复`, task.outputs[d.with])}如果方案需要调整，输出修订后的完整方案；如果需要用户决定，提出一个具体问题。\n\n${DECISION_FORMAT}`
}

export const reapplyPrompt = (plan: string): string =>
  `${section('方案已修订', plan)}请按修订后的方案调整实现。最后简要说明你做了什么。`

export const instructPrompt = (instruction: string): string =>
  `${section('用户的指示', instruction)}请据此调整实现。最后简要说明你做了什么。`

export const stuckQuestion = (task: Task, d: DialogNode): string => {
  const tail = task.dialog?.escalated ? `，「${d.escalate}」已重新确认过一次` : ''
  return `评审「${d.id}」和「${d.with}」对话 ${d.maxRounds} 轮仍未通过${tail}。最新评审意见：\n${task.dialog?.lastCritique ?? '（无）'}\n\n请告诉我接下来怎么做。`
}
