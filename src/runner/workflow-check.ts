// 建任务前核对工作流的每个角色：执行器登记了、做得到角色要的能力面。建任务和对话 agent 提议建任务都用它。
import type { ExecutorCheck } from '../executor/types.ts'
import { needsOf } from '../executor/types.ts'
import type { Workflow } from '../workflow/types.ts'
import { roleProfile } from './runner.ts'

/** 第一个做不到的角色的原因；都做得到（或者不核对）时 undefined。 */
export const workflowProblem = (workflow: Workflow, check: ExecutorCheck | undefined): string | undefined => {
  if (check === undefined) return undefined
  for (const [key, r] of Object.entries(workflow.roles)) {
    const problem = check(r.executor, needsOf({ ...roleProfile(r), skills: r.skills }))
    if (problem !== undefined) return `工作流 ${workflow.name} 的角色 ${key}：${problem}`
  }
  return undefined
}
