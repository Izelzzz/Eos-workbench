// devbench 的类型契约：任务、阶段运行记录，以及 $.state 中保存的值。

/** 流水线中的阶段 id，顺序见 hooks/core/pipeline.ts 的 STAGES。 */
export type StageId = 'spec' | 'dev' | 'test' | 'review' | 'merge' | 'deploy'

/** 单个阶段的状态。waiting = 等待人工批准。 */
export type StageStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'passed'
  | 'failed'
  | 'skipped'

/** 任务整体状态。 */
export type TaskStatus = 'running' | 'waiting' | 'done' | 'failed' | 'aborted'

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** 这次运行为什么开始：第一次、返工回来、被驳回重跑、人工重试。 */
export type RunCause = 'initial' | 'rework' | 'reject' | 'retry'

/** abandoned = 中止或重试时被放弃（子 agent 或命令已停掉）。 */
export type RunOutcome = 'running' | 'passed' | 'failed' | 'abandoned'

/** 阶段的某一次运行（按 seq 一一对应）。 */
export type RunRecord = {
  seq: number
  /** 开始时的 attempts（重试运行中的那次时与被放弃的那次相同）。 */
  attempt: number
  cause: RunCause
  startedAt: number
  endedAt?: number
  /** 这次运行的执行耗时；被放弃的运行也包括它迟到回报的用量。 */
  durationMs: number
  tokens: Tokens
  model?: string
  effort?: string | number
  skills?: string[]
  agentId?: string
  outcome: RunOutcome
  note?: string
  /** 这次运行写下的产物（被覆盖的那几个用带 seq 的副本名），相对 artifacts/。 */
  artifacts: string[]
}

/**
 * 一个阶段在某个任务里的累计运行记录（返工时累加）。
 * durationMs / tokens 等于 runs 里未被放弃的那些之和；被放弃运行的用量只在 runs 里。
 */
export type StageRun = {
  stage: StageId
  status: StageStatus
  /** 运行次数（返工会让 dev / test / review 多次运行）。 */
  attempts: number
  /**
   * 这次运行的编号：每次开始运行加一，重试运行中的那次也加一（attempts 不加），从不回退。
   * finished / progress 带着它认领运行，旧运行迟到的结果对不上编号，被忽略。
   */
  seq: number
  /** 当前这次运行开始的时间（ms）。 */
  startedAt?: number
  /** 最近一次结束的时间（ms）。 */
  endedAt?: number
  /** 所有运行的执行耗时之和（价值流的 Process Time）。 */
  durationMs: number
  /** 进入 waiting 的时刻，用来累计 waitMs。 */
  waitingSince?: number
  /** 等待人工批准的总时长（价值流的 Wait Time）。 */
  waitMs: number
  tokens: Tokens
  model?: string
  /** 正在运行的子 agent id，用来把 turn.complete 对回这个阶段。 */
  agentId?: string
  /** 最近一次的说明：失败原因、驳回理由、跳过原因。 */
  note?: string
  /** 产物路径，相对任务目录。 */
  artifacts: string[]
  /** 每次运行的明细。早于这个字段的 task.json 读入时为空数组，只剩上面的累计值。 */
  runs: RunRecord[]
}

export type Task = {
  id: string
  title: string
  request: string
  createdAt: number
  updatedAt: number
  endedAt?: number
  status: TaskStatus
  current: StageId
  stages: Record<StageId, StageRun>
  /** 已返工次数（test / review 打回 dev）。 */
  rework: number
  /** 给下一次 spec / dev / review 运行的反馈（驳回理由、测试输出、评审意见）。 */
  feedback?: string
  /** 一次通过：test、review 第一次运行就通过才为 true。 */
  firstPass: { test?: boolean; review?: boolean }
  /** git 信息：基线分支与 commit、任务分支、worktree 绝对路径。 */
  git: { baseBranch: string; baseSha: string; branch: string; worktree: string }
  /** 任务目录（绝对路径），产物在其中的 artifacts/ 下。 */
  dir: string
}

export type StageAgentConfig = {
  model?: string
  effort?: string | number
  /** skill 名（例如 pstack:poteto-mode）。 */
  skills?: string[]
}

/** .devbench.json 里的配置，均可省略。 */
export type DevbenchConfig = {
  /** 单元测试命令（argv，不经 shell）。省略时若 package.json 有 test 脚本则用 npm test，否则跳过该阶段。 */
  testCommand?: string[] | null
  /** 部署命令（argv）。省略则跳过部署阶段。 */
  deployCommand?: string[] | null
  /** 最多返工几次，默认 2。 */
  maxRework?: number
  /** 各角色模型：别名（opus / sonnet / haiku）、完整 id 或 inherit。 */
  models?: { planner?: string; developer?: string; reviewer?: string }
  /** 各子 agent 阶段的模型、effort 与预加载的 skill；model 优先于 models 里对应角色的设置。 */
  stages?: Partial<Record<'spec' | 'dev' | 'review', StageAgentConfig>>
  /** 额外受保护的命令正则（字符串形式），任务进行中模型不可直接执行。 */
  protectedCommands?: string[]
}

declare module 'claude-code' {
  interface PluginState {
    devbench: {
      tasks: Shaped<Task[]>
      selected: string | null
    }
  }
}
