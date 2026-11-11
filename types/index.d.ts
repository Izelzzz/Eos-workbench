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

/** 一个阶段在某个任务里的累计运行记录（返工时累加）。 */
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
