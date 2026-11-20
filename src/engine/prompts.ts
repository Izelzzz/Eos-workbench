// 每种调用用途的提示词。纯函数：只读任务状态，不做 IO。
import type { AgentNode, DialogNode, NodeId, Workflow, WorkflowNode } from '../workflow/types.ts'
import { node as nodeOf, role as roleOf } from '../workflow/types.ts'
import { describeCheck, describeFailures, describeRequirements } from './checks.ts'
import type { CheckResult, ReviewKind, Task } from './types.ts'

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

const conventions = (task: Task): string =>
  task.docs.map(d => section(`团队约定：${d.name}（第 ${d.version} 版）`, d.content)).join('')

/** 会话的第一条消息带上团队约定和角色说明；之后同一会话里不再重复。 */
const intro = (task: Task, session: NodeId, wf: Workflow, n: WorkflowNode): string =>
  task.sessions[session] === undefined && n.role !== undefined ? conventions(task) + section('你的角色', roleOf(wf, n.role).prompt) : ''

const requirements = (n: WorkflowNode): string =>
  section('交付要求（完成后平台会逐条检查，不通过会退回给你补齐）', n.checks.length === 0 ? undefined : describeRequirements(n.checks))

const context = (task: Task, n: WorkflowNode): string =>
  section('需求', task.request) + section('环境', task.context) + n.inputs.map(i => section(`上游产出：${i}`, task.outputs[i])).join('')

export const producePrompt = (task: Task, n: WorkflowNode): string =>
  `${intro(task, n.id, task.workflow, n)}${section('任务', n.task)}${context(task, n)}${requirements(n)}完成后，你的最终回复就是这一步的产出。`

export const fixPrompt = (task: Task, n: AgentNode, results: CheckResult[]): string =>
  `${intro(task, n.id, task.workflow, n)}${section('交付物检查没有通过', describeFailures(results))}请在原来的工作上补齐，不要从头重来。完成后简要说明你改了什么。`

export const fixInstructPrompt = (instruction: string): string =>
  `${section('用户的指示', instruction)}请据此补齐交付物。完成后简要说明你改了什么。`

/** 检查用完补齐次数仍没通过，问用户。 */
export const checksStuckQuestion = (n: AgentNode, results: CheckResult[]): string =>
  `「${n.id}」的交付物自动补齐 ${n.maxFixes} 次后仍没有通过检查：\n${describeFailures(results)}\n\n请告诉我接下来怎么做。`

/** 对话有检查时，评审方只在检查通过后才被请来；告诉它哪些已经由平台验证过。 */
const checked = (d: DialogNode): string =>
  section('平台检查（本轮已通过）', d.checks.length === 0 ? undefined : d.checks.map(c => `- ${describeCheck(c)}`).join('\n'))

export const critiquePrompt = (task: Task, d: DialogNode, kind: ReviewKind | 'format'): string => {
  const head = intro(task, d.id, task.workflow, d) + (kind === 'format' ? '' : checked(d))
  const reply = task.outputs[d.with]
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
  return `${intro(task, d.with, task.workflow, target)}${section(`${d.role === undefined ? '检查没有通过' : '评审意见'}（第 ${task.dialog?.round ?? 1} 轮）`, critique)}逐条处理：修改、回答问题，或带着理由反驳。最后简要说明你做了什么。`
}

export const reconfirmPrompt = (task: Task, d: DialogNode, input: { stuck: true } | { instruction: string } | { format: true }): string => {
  const up = nodeOf(task.workflow, d.escalate!)
  const head = intro(task, up.id, task.workflow, up)
  if ('format' in input) return `${head}你上一条回复无法解析。\n\n${DECISION_FORMAT}`
  if ('instruction' in input) return `${head}${section('用户的指示', input.instruction)}请据此输出修订后的完整方案；如果仍需用户决定，提出具体问题。\n\n${DECISION_FORMAT}`
  const stuck = `「${d.with}」和「${d.id}」对话 ${d.maxRounds} 轮仍未通过。`
  return `${head}${section('需要你重新确认做法与需求', stuck)}${section('最近一轮没通过的原因', task.dialog?.lastCritique)}${section(`${d.with} 最后的回复`, task.outputs[d.with])}如果方案需要调整，输出修订后的完整方案；如果需要用户决定，提出一个具体问题。\n\n${DECISION_FORMAT}`
}

export const reapplyPrompt = (plan: string): string =>
  `${section('方案已修订', plan)}请按修订后的方案调整实现。最后简要说明你做了什么。`

export const instructPrompt = (instruction: string): string =>
  `${section('用户的指示', instruction)}请据此调整实现。最后简要说明你做了什么。`

export const stuckQuestion = (task: Task, d: DialogNode): string => {
  const tail = task.dialog?.escalated ? `，「${d.escalate}」已重新确认过一次` : ''
  return `「${d.id}」和「${d.with}」对话 ${d.maxRounds} 轮仍未通过${tail}。最近一轮没通过的原因：\n${task.dialog?.lastCritique ?? '（无）'}\n\n请告诉我接下来怎么做。`
}
