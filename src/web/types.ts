// Web 接口返回的数据类型（纯类型，前端也引用）。
import type { CredentialInfo, CredentialKind } from '../credentials/types.ts'
import type { RemoteRepo } from '../forge/types.ts'
import type { TaskMetrics } from '../engine/metrics.ts'
import type { Report } from '../engine/report.ts'
import type { CheckLink, GatePhase, Question, TaskStatus } from '../engine/types.ts'
import type { ConventionKind, ConventionRow, ConventionsUsed, ConventionSummary, ProposalRow } from '../store/types.ts'
import type { Span } from '../trace/types.ts'
import type { Comparison } from '../engine/compare.ts'
import type { Signal } from '../engine/evidence.ts'
import type { Usage } from '../engine/types.ts'
import type { Refused } from '../improve/parse.ts'

/** 卡点上的一次验收结论。by：human 是人，否则是验收的角色。 */
export type GateDecision = { round: number; by: string; pass: boolean; comment: string; at: number }

/** 任务停在卡点上时，任务页要显示的内容。 */
export type GateInfo = {
  node: string
  /** 被验收的节点。 */
  with: string
  /** 验收人：human 是能访问平台的任何人，agent 是 role 角色的 agent。 */
  by: { kind: 'human' } | { kind: 'agent'; role: string }
  /** 验收人的说明（「任何能访问平台的人」「角色「rev」的 agent」）。 */
  approver: string
  /** 验收说明（模板里卡点的 task）。 */
  task: string
  round: number
  phase: GatePhase
  /** 正在等人验收：页面上可以通过或打回。 */
  waiting: boolean
  /** 被验收节点最新的产出。 */
  output?: string
  /** 这个卡点上已有的结论，按先后。 */
  decisions: GateDecision[]
}

export type TaskDetail = {
  id: string
  status: TaskStatus
  workflow: string
  request: string
  position: string
  question?: Question
  /** 停在卡点上时才有。 */
  gate?: GateInfo
  failure?: string
  /** 这个任务的日志文件（平台所在机器上的路径，只用来显示；内容用 /api/tasks/:id/log 看）。 */
  logPath: string
  /** 仓库、分支、worktree 都是平台所在机器上的路径，只用来显示。 */
  repo: string
  /** 任务来自托管平台上的仓库时：是哪个仓库（repo 是平台里的镜像）。 */
  remote?: RemoteRepo
  /** 检查产出的链接（推上去的分支、开出的 PR 等）：同一个地址只保留一条，按最后一次出现的先后排列。 */
  links: CheckLink[]
  branch: string
  worktree: string
  baseSha: string
  report: Report
  /** 按阶段的 token 和时长构成，进行中的部分算到服务端处理请求的时刻。 */
  metrics: TaskMetrics
  trace: Span
  /** 有 runner 进程正在跑这个任务（看锁文件）。为 false 时回答对话尽头的问题后需要 resume。 */
  runnerAlive: boolean
  /** 创建任务时用的团队约定版本（第 1 块之前创建的任务没有）。 */
  conventions?: ConventionsUsed
}

export type { FileChange, FileDiff, TaskChanges } from '../runner/changes.ts'

export type AnswerRequest = { questionId: string; text: string }
export type AnswerResponse = { ok: true; resumeNeeded: boolean } | { ok: false; error: string }

/** 人在卡点上的结论：gate、round 指明验收的是哪一次（页面上看到的那一次），过期的被拒绝；打回时 comment 不能为空。 */
export type GateRequest = { gate: string; round: number; pass: boolean; comment: string }
/** resumeNeeded：结论记下了，但没有 runner 接着做（起不来），要点「继续」。 */
export type GateResponse = { ok: true; resumeNeeded: boolean } | { ok: false; error: string }

export type CreateResponse = { ok: true; id: string } | { ok: false; error: string }
export type ActionResponse = { ok: true } | { ok: false; error: string }
export type WorkflowInfo = { name: string; version: number; description?: string; nodes: string[] }

/** 带位置的错误，例如 { path: 'nodes[2].with', message: '…' }。 */
export type FieldError = { path: string; message: string }

export type TemplateInfo = ConventionSummary & { description?: string; write?: 'none' | 'worktree' }
export type SkillInfo = ConventionSummary & { description?: string }
export type ConventionsResponse = { workflows: WorkflowInfo[]; docs: ConventionSummary[]; templates: TemplateInfo[]; skills: SkillInfo[] }
export type ConventionDetail = { kind: ConventionKind; name: string; versions: ConventionRow[] }
export type SaveConventionRequest = { content: string; note?: string; validateOnly?: boolean }
export type SaveConventionResponse = { ok: true; version?: number } | { ok: false; errors: FieldError[] } | { ok: false; error: string }

/** 提案列表的一行：latestVersion 是目标约定现在的最新版本（不等于 baseVersion 时批准会过期）。 */
export type ProposalInfo = ProposalRow & { latestVersion?: number }
/** 提案详情：带上提案基于的那一版内容（页面做新旧对比）和引用的证据原文（任务被删了的证据不在里面）。 */
export type ProposalDetail = ProposalInfo & { base?: ConventionRow; signals: Signal[]; comparison?: Comparison }
/** 一条已批准的提案和它生成的版本的前后对比。 */
export type ImprovementComparison = { proposal: { id: number; target: ProposalRow['target']; rationale: string; approvedAt: number }; comparison: Comparison }
export type GenerateRequest = { workflow: string; tasks?: string[] }
/** 生成的结果：created 入库的提案，refused 没入库的和原因，skipped 没有证据、没调用模型。 */
export type GenerateResponse =
  | { ok: true; created: ProposalRow[]; refused: Refused[]; skipped?: string; call?: { model?: string; usage: Usage; ms: number } }
  /** call：调用过模型之后才失败（调用了工具、回复无法解析）时带上用量和回复的开头。 */
  | { ok: false; error: string; call?: { model?: string; usage: Usage; ms: number; replyHead: string } }
export type DecideRequest = { note?: string } | { reason: string }
export type DecideResponse = { ok: true; proposal: ProposalRow } | { ok: false; error: string }

/** 凭据页：usable 为 false 时没有主密钥，只能列出和删除；hint 写明怎么设置主密钥。列表里没有凭据的值。 */
export type CredentialsResponse = { usable: boolean; keyId?: string; hint?: string; items: CredentialInfo[] }
export type SaveCredentialRequest = { name: string; kind: CredentialKind; value: string }
export type SaveCredentialResponse = { ok: true } | { ok: false; error: string }
export type DeleteCredentialResponse = { ok: true } | { ok: false; error: string }

/** 托管平台 App（例如 GitHub App）的注册情况。name 是它在凭据存储里的名字；registered 是已经存了凭据。 */
export type ForgeAppInfo = {
  name: string
  host: string
  appNameMax: number
  registered?: { updatedAt: number; installUrl?: string }
  /**
   * 用户授权（OAuth）：托管平台支持时才有。authorized 是已经授权的人（error 是授权读不出来时的原因）；
   * unavailable 是现在不能发起授权的原因（例如 App 是早先注册的、没有 client id）。
   */
  user?: { authorized?: { login: string; updatedAt: number } | { error: string }; unavailable?: string }
}
/** callbackUrl：注册完托管平台跳回的地址，就是浏览器现在访问平台用的地址加上回调路径。 */
export type ForgeAppsResponse = { usable: boolean; hint?: string; callbackUrl: string; apps: ForgeAppInfo[] }
export type RegisterAppRequest = { name: string; appName: string; org?: string }
/** 浏览器把 fields 作为表单字段 POST 到 action（托管平台的页面）。 */
export type AuthorizeUserResponse = { ok: true; url: string } | { ok: false; error: string }
/** warning：平台这边已经删掉了授权，但没能在托管平台上撤销（要用户自己去撤销）。 */
export type RevokeUserResponse = { ok: true; warning?: string } | { ok: false; error: string }
export type RegisterAppResponse = { ok: true; action: string; fields: Record<string, string> } | { ok: false; error: string }
