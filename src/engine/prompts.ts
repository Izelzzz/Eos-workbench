// 每种调用用途的提示词。纯函数：只读任务状态，不做 IO。
import type { AgentNode, DialogNode, GateNode, NodeId, Workflow, WorkflowNode } from '../workflow/types.ts'
import { node as nodeOf, role as roleOf, roleOfNode } from '../workflow/types.ts'
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

const conventions = (task: Task): string => task.docs.map(d => section(`团队约定：${d.name}（第 ${d.version} 版）`, d.content)).join('')

/** 范围外的位置怎么办：会话开头和越界撤销后的说明用同一条规则，agent 不为路径问用户。 */
const SCOPE_RULE =
  '可写范围由团队的 Agent 模板决定，任务里改不了。写每个文件之前，先核对它的路径匹配上面的某一条；' +
  '需求、规格、方案或评审里点名的路径也一样要核对。点名的位置在范围外时，改放到范围内最合适的位置，' +
  '并在回复里写明原来要求的位置、实际放在了哪里、为什么。要改的就是范围外某个已有文件本身、换个位置没有意义时，' +
  '不要另造替代文件，在回复里说明这一项没做和原因。不要为路径向用户提问，也不要建议放宽范围。范围外的改动会在提交前被平台撤销。'

/** 角色的可写范围，事先告诉 agent，免得它写到范围外再被撤销。只读角色说明它不能改文件。 */
export const writeScope = (write: 'none' | 'worktree', writePaths: string[]): string =>
  write === 'none'
    ? '你这个角色是只读的，不能改动任何文件；要交付的内容写在回复里。'
    : writePaths.includes('**')
      ? '你可以改动任务 worktree 里的文件（指向目录的符号链接、嵌套的 git 仓库除外）。'
      : `你可以改动的路径（任务 worktree 内的 glob）：\n${writePaths.map(p => `- ${p}`).join('\n')}\n\n${SCOPE_RULE}`

/** 会话的第一条消息带上团队约定、角色说明和可写范围；之后同一会话里不再重复。 */
const intro = (task: Task, session: NodeId, wf: Workflow, n: WorkflowNode): string => {
  const id = roleOfNode(n)
  if (task.sessions[session] !== undefined || id === undefined) return ''
  const r = roleOf(wf, id)
  return conventions(task) + section('你的角色', r.prompt) + section('你的可写范围', writeScope(r.write, r.writePaths))
}

const requirements = (n: WorkflowNode): string => section('交付要求（完成后平台会逐条检查，不通过会退回给你补齐）', n.checks.length === 0 ? undefined : describeRequirements(n.checks))

const context = (task: Task, n: WorkflowNode): string => section('需求', task.request) + section('环境', task.context) + n.inputs.map(i => section(`上游产出：${i}`, task.outputs[i])).join('')

/**
 * 上一次回复里有改动超出了角色的可写范围，已经被平台撤销：加在这个会话下一次调用的提示词最前面。
 * 既列被撤销的路径，也列允许改动的路径和范围外怎么办，免得 agent 再试一次或来问用户。
 */
export const scopeNotice = (reverted: string[], allowed: string[]): string =>
  section(
    '有改动被撤销（超出你的可写范围）',
    `上一次回复之后，以下改动不在你的可写范围内，已经被撤销，也没有提交：\n${reverted.map(p => `- ${p}`).join('\n')}\n\n` + writeScope(allowed.length === 0 ? 'none' : 'worktree', allowed),
  )

export const producePrompt = (task: Task, n: WorkflowNode): string =>
  `${intro(task, n.id, task.workflow, n)}${section('任务', n.task)}${context(task, n)}${requirements(n)}完成后，你的最终回复就是这一步的产出。`

export const fixPrompt = (task: Task, n: AgentNode, results: CheckResult[]): string =>
  `${intro(task, n.id, task.workflow, n)}${section('交付物检查没有通过', describeFailures(results))}请在原来的工作上补齐，不要从头重来。完成后简要说明你改了什么。`

export const fixInstructPrompt = (instruction: string): string => `${section('用户的指示', instruction)}请据此补齐交付物。完成后简要说明你改了什么。`

/** 检查用完补齐次数仍没通过，问用户。 */
export const checksStuckQuestion = (n: AgentNode, results: CheckResult[]): string =>
  `「${n.id}」的交付物自动补齐 ${n.maxFixes} 次后仍没有通过检查：\n${describeFailures(results)}\n\n请告诉我接下来怎么做。`

/** 对话有检查时，评审方只在检查通过后才被请来；告诉它哪些已经由平台验证过。 */
const checked = (d: DialogNode): string => section('平台检查（本轮已通过）', d.checks.length === 0 ? undefined : d.checks.map(c => `- ${describeCheck(c)}`).join('\n'))

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

export const reapplyPrompt = (plan: string): string => `${section('方案已修订', plan)}请按修订后的方案调整实现。最后简要说明你做了什么。`

export const instructPrompt = (instruction: string): string => `${section('用户的指示', instruction)}请据此调整实现。最后简要说明你做了什么。`

export const stuckQuestion = (task: Task, d: DialogNode): string => {
  const tail = task.dialog?.escalated ? `，「${d.escalate}」已重新确认过一次` : ''
  return `「${d.id}」和「${d.with}」对话 ${d.maxRounds} 轮仍未通过${tail}。最近一轮没通过的原因：\n${task.dialog?.lastCritique ?? '（无）'}\n\n请告诉我接下来怎么做。`
}

/** 卡点上等谁验收，给提示词、状态说明和命令行用。 */
export const approverOf = (g: GateNode): string => (g.by.kind === 'human' ? '任何能访问平台的人' : `角色「${g.by.role}」的 agent`)

/** 卡点打回后重跑的检查（如果有），告诉验收的 agent 这些已经由平台验证过。 */
const rechecked = (g: GateNode): string => section('平台检查（修改后已重跑并通过）', g.checks.length === 0 ? undefined : g.checks.map(c => `- ${describeCheck(c)}`).join('\n'))

/**
 * agent 验收：第一次给完整的任务、需求、上游产出和被验收的产出；之后（打回、修改之后）在同一会话里只给修改后的回复。
 * 结论和评审一样按 VERDICT_FORMAT 解析。
 */
export const acceptPrompt = (task: Task, g: GateNode, kind: 'first' | 'again' | 'format'): string => {
  const head = intro(task, g.id, task.workflow, g)
  const round = task.gate?.round ?? 1
  switch (kind) {
    case 'first':
      return `${head}${section('验收', g.task)}${context(task, g)}${section(`待验收：${g.with} 的产出`, task.outputs[g.with])}请查看改动（git diff，方法见环境说明）后给出验收结论。\n\n${VERDICT_FORMAT}`
    case 'again':
      return `${head}${rechecked(g)}${section(`第 ${round} 次验收：${g.with} 修改后的回复`, task.outputs[g.with])}请复核最新改动（git diff）后重新给出验收结论。\n\n${VERDICT_FORMAT}`
    case 'format':
      return `${head}你上一条回复无法解析成验收结论。\n\n${VERDICT_FORMAT}`
  }
}

/** 被验收方修改：按打回意见、重跑检查的失败，或用户的指示。在它原来的会话里说话。 */
export const amendPrompt = (task: Task, g: GateNode, input: { comment: string; round: number } | { failures: CheckResult[] } | { instruction: string }): string => {
  const target = nodeOf(task.workflow, g.with)
  const head = intro(task, g.with, task.workflow, target)
  if ('instruction' in input) return `${head}${section('用户的指示', input.instruction)}请据此修改。最后简要说明你做了什么。`
  if ('failures' in input) return `${head}${section('按验收意见修改之后，重跑检查没有通过', describeFailures(input.failures))}请在原来的工作上修好。最后简要说明你改了什么。`
  return `${head}${section(`验收没有通过（第 ${input.round} 次验收，验收人：${approverOf(g)}）`, input.comment)}请在原来的工作上按意见修改，不要从头重来；意见不对时带着理由说明。最后简要说明你做了什么。`
}

/** 卡点上自动处理用完了，问用户：agent 验收打回次数用完，或修改后重跑检查补齐次数用完。 */
export const gateStuckQuestion = (task: Task, g: GateNode, why: 'rounds' | 'checks'): string => {
  const head =
    why === 'rounds' && g.by.kind === 'agent'
      ? `「${g.id}」由${approverOf(g)}验收，打回 ${g.by.maxRounds} 次后仍没有通过。最近一次的意见：`
      : `「${g.id}」打回修改之后，重跑检查自动交回修改 ${g.maxFixes} 次仍没有通过：`
  return `${head}\n${task.gate?.lastComment ?? '（无）'}\n\n请告诉我接下来怎么做。`
}
