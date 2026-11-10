---
name: verify-stage-state-machine
description: 穷举验证 devbench 流水线状态机（hooks/core/pipeline.ts 的 reduce、TRANSITIONS、agentToStop）。改动 hooks/core/pipeline.ts、阶段失败或驳回的去向表 TRANSITIONS、STAGES、Event 或 types/index.d.ts 里的 Task / StageRun 时使用；提交前必须跑一遍。
---

# 验证流水线状态机

`tests/state-space.test.ts` 从 `startTask` 出发，对真实的 `reduce` 做广度优先穷举：每个可达状态上都喂一遍全部事件，检查每一步是否守住下面的不变量。验证的是代码本身，不是手写模型。

选这个工具的原因：状态机是一个纯函数，直接在测试里枚举就能覆盖它的全部状态，不需要另写 TLA+ 模型、也不需要装 Java 和 TLC，`claude plugin test .` 就能跑。

## 运行

```bash
claude plugin test .
```

通过的样子：每种配置两条 `状态空间（…）` 测试都是 pass，测试名里写着穷举了多少个抽象状态，并且没有触及深度上限。四种配置：完整配置（maxRework 2、有测试、有部署）、无测试、无部署、不允许返工（maxRework 0）。

## 不变量

每条都是测试里 `INVARIANTS`（以及 `STUCK`）的一项，名字就是失败输出里的 `invariant`。

| 不变量 | 违反时的后果 |
|---|---|
| 没有卡死的状态：每个没有完成或中止的任务，都有中止以外的事件能推动它 | 用户只能放弃这个任务 |
| 合并只发生在评审之后：merge 运行或通过时，review 已通过或已跳过；`done` 时 merge 和 deploy 已通过或已跳过 | 未经评审的代码进了基线分支，或没合并就显示完成 |
| 不留孤儿子 agent：运行中阶段的 agentId 在一步之后不见了，要么事件是 `finished`，要么 `agentToStop` 返回了它 | 子 agent 在后台继续改 worktree、耗额度 |
| progress 不改变阶段与状态 | 中途的 turn 就把阶段判完 |
| 返工进入开发时必带反馈：从 test / review / merge 进入 dev 时，feedback 非空 | 开发 agent 不知道为什么被打回 |
| 空理由的驳回被拒绝：理由为空或全是空白时任务不变、动作为 `none` | 下一轮 agent 只能猜 |
| 返工次数不超过上限：`rework <= maxRework` | 测试或评审一直不过时无限循环 |
| 合并前驳回回到评审并带上理由：review 变成 running，feedback 含理由 | 人工意见绕过评审，或理由丢失 |
| 评审只在合并前被驳回时才拿到反馈：从 dev / test 进入 review 时 feedback 为空 | 返工用的测试输出被当成「人工驳回理由」交给评审者 |

## 读失败

失败输出是一个数组，每项有 `invariant`、`harm` 和 `counterexample`。反例是从 `startTask` 起的最短事件序列，例如 `finished(spec, ok) → approve → finished(dev, ok) → finished(test, fail)`。按这个序列用 `tests/pipeline.test.ts` 里的 `play` 手动重放，看最后一步的 `reduce` 输入输出。

判断是真 bug 还是探索器的问题：

- 重放出来的任务确实违反了那句不变量，并且这是用户能遇到的事件顺序：真 bug，修 `pipeline.ts`。不要为了通过而放宽不变量。
- 重放不出来：多半是抽象出了问题。探索器按 `keyOf` 合并状态，每个抽象状态只保留第一次遇到的具体任务。如果新代码开始依赖 `keyOf` 没记录的字段（例如 feedback 的具体内容、attempts 大于 2 的取值、note），把那个字段加进 `keyOf`。
- 深度上限那条失败：状态空间变大了或出现了不收敛的计数器。先确认计数器有界，再考虑调 `MAX_DEPTH`。
- 反例里的事件在引擎层不可能发生（例如给非 agent 阶段模拟了 agentId）：修探索器的 `alphabet` 或 `spawn`。

## 行为有意改变时

1. 改 `TRANSITIONS` 或 `reduce`。
2. 如果某条不变量描述的正是旧行为，改那条不变量的句子、`harm` 和 `holds`，在提交说明里写为什么。
3. 新的事件种类加进 `alphabet` 和 `label`；新的影响流转的字段加进 `keyOf`；新的子 agent 阶段加进 `AGENT_STAGES`。
4. 对新增或改动的不变量做一次「故意改坏」：在 `pipeline.ts` 里做一个只破坏它的临时改动，确认测试报的正是这条，再还原。
5. 全部通过后更新下面的同步提交。

## 范围与假设

- 覆盖：`reduce` 对 `alphabet` 里每种事件的全部可达状态（在 `keyOf` 抽象下），四种配置。事件只针对当前阶段；发给非当前阶段的过期 `finished` / `progress` 没有枚举（`reduce` 对它们直接返回原任务）。
- 子 agent 用 `spawn` 模拟：动作是 `run` 且阶段是 spec / dev / review 时，给该阶段写一个新的 agentId。
- 不覆盖：`hooks/register.tsx` 引擎层（`dispatch` 串行队列、真正停止 agent、写文件、命令执行）、时间与耗时的统计、真实 agent 的输出、`flowMetrics`、并发事件的交错。
- 时间戳是单调递增的计数器，不验证 waitMs / durationMs 的数值。

## 覆盖记录

| 文件 | 函数 / 数据 |
|---|---|
| `hooks/core/pipeline.ts` | `reduce`、`startTask`、`agentToStop`、`TRANSITIONS`、`STAGES`、`advanceFrom`、`goBack`、`follow`、`begin`、`wait`、`finish`、`fail` |
| `types/index.d.ts` | `Task`、`StageRun` 的状态字段 |

同步提交：`78ce2373052598936b68e810cb6444beeeb00e0c`。上面的文件在这个提交之后有改动，就要重新确认探索器仍然描述代码。只有确认之后（必要时更新了探索器并做过一次故意改坏），才把这里的提交号往前移。
