// 假模型的剧本：给 CI 里的确定性 E2E 用（scripts/e2e-ci.ts），不调真实模型也能把平台、dsh、沙箱、git、检查命令整条链路跑一遍。
// 剧本对应 scripts/e2e.ts 的需求（sum 函数 + 测试）和 feature 模板的三个角色，按「角色 × 这一轮进行到哪一步」决定回复。
// 这里是纯逻辑：输入 dsh 发来的请求体（Anthropic Messages 格式），输出一次回复（一次工具调用或一段文字）。

/** dsh 发来的请求里用到的部分 */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string }
export type Message = { role: 'user' | 'assistant' | 'system'; content: Block[] }
export type Request = { model: string; messages: Message[]; tools?: { name: string }[] }

/** 一次回复：调一个工具，或者回一段文字（结束这一轮） */
export type Reply = { kind: 'tool'; name: string; input: Record<string, unknown> } | { kind: 'text'; text: string }

export type Role = 'planner' | 'developer' | 'reviewer'

/** 角色按 feature 模板里各角色提示词的开头认（平台把它放在会话第一条消息的「# 你的角色」下面） */
const ROLE_MARKERS: [Role, string][] = [
  ['planner', '你是资深技术负责人'],
  ['developer', '你是严谨的软件工程师'],
  ['reviewer', '你是独立的代码评审者'],
]

const texts = (m: Message): string => m.content.map(b => (b.type === 'text' ? (b as { text: string }).text : '')).join('\n')
const isPrompt = (m: Message) => m.role === 'user' && m.content.some(b => b.type === 'text')

export function roleOf(req: Request): Role | undefined {
  const first = req.messages.find(isPrompt)
  const t = first === undefined ? '' : texts(first)
  return ROLE_MARKERS.find(([, marker]) => t.includes(marker))?.[0]
}

/** 这一轮：最后一条平台发来的文字消息，以及它之后模型已经调过的工具（按顺序） */
export function turnOf(req: Request): { prompt: string; index: number; toolsDone: string[] } {
  let index = -1
  req.messages.forEach((m, i) => {
    if (isPrompt(m)) index = i
  })
  const toolsDone = req.messages.slice(index + 1).flatMap(m => (m.role === 'assistant' ? m.content.filter(b => b.type === 'tool_use').map(b => (b as { name: string }).name) : []))
  return { prompt: index < 0 ? '' : texts(req.messages[index]!), index, toolsDone }
}

/** 一轮里要依次做的工具调用，做完后回 final 这段文字 */
type Turn = { tools: Reply[]; final: string }

const tool = (name: string, input: Record<string, unknown>): Reply => ({ kind: 'tool', name, input })
const write = (file_path: string, content: string) => tool('write', { file_path, content })
const bash = (description: string, command: string) => tool('bash', { description, command })

const MATH = `// 数学工具函数

/** 求和：数组里每一项都必须是数字（不含 NaN），空数组返回 0 */
export function sum(xs) {
  if (!Array.isArray(xs)) throw new TypeError('sum 需要一个数组')
  return xs.reduce((total, x) => {
    if (typeof x !== 'number' || Number.isNaN(x)) throw new TypeError(\`不是数字：\${String(x)}\`)
    return total + x
  }, 0)
}
`

const TESTS_V1 = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum } from '../src/math.js'

test('求和', () => {
  assert.equal(sum([1, 2, 3]), 6)
})

test('空数组返回 0', () => {
  assert.equal(sum([]), 0)
})
`

const TESTS_V2 = `${TESTS_V1}
test('有非数字时抛 TypeError', () => {
  assert.throws(() => sum([1, '2']), TypeError)
  assert.throws(() => sum([NaN]), TypeError)
  assert.throws(() => sum('12'), TypeError)
})
`

const verdict = (v: { verdict: 'pass' | 'changes'; summary: string; issues: { severity: string; file?: string; message: string }[] }) => `\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``

/** 剧本：角色 × 这一轮是第几种情况 */
function turnFor(role: Role, prompt: string, isFirstTurn: boolean): Turn {
  switch (role) {
    case 'planner':
      return {
        tools: [tool('ask_user_question', { questions: [{ id: 'name', question: '函数名用 sum 还是 total？', options: [{ label: 'sum' }, { label: 'total' }] }] })],
        final: [
          '## 方案',
          '- 在 src/math.js 导出求和函数（名字按用户的回答），接收数字数组返回总和；空数组返回 0；有非数字时抛 TypeError。',
          '- 在 test/ 下用 node:test 写测试，`npm test` 通过。',
          '## 验收标准',
          '1. 求和正确；2. 空数组返回 0；3. 非数字抛 TypeError；4. `npm test` 通过。',
        ].join('\n'),
      }
    case 'developer':
      return isFirstTurn
        ? {
            tools: [write('src/math.js', MATH), write('test/math.test.js', TESTS_V1), bash('运行测试', 'npm test')],
            final: '改了什么：在 src/math.js 实现 sum，在 test/math.test.js 加了测试。验证：npm test 通过。',
          }
        : {
            tools: [write('test/math.test.js', TESTS_V2), bash('运行测试', 'npm test')],
            final: '按评审意见补了非数字输入的测试（字符串、NaN、非数组）。验证：npm test 通过。',
          }
    case 'reviewer':
      // 第一次评审打回一次（验证对话循环），之后的轮次（「第 N 轮」、方案重新确认后）都通过
      return /第 \d+ 轮|方案已重新确认/.test(prompt)
        ? { tools: [bash('查看改动', 'git diff HEAD~1')], final: verdict({ verdict: 'pass', summary: '补上了边界情况的测试，满足验收标准。', issues: [] }) }
        : {
            tools: [bash('查看改动', 'git log --oneline'), bash('运行测试', 'npm test')],
            final: verdict({
              verdict: 'changes',
              summary: '实现正确，但缺少非数字输入的测试。',
              issues: [{ severity: 'major', file: 'test/math.test.js', message: '补充验收标准 3 的测试：数组里有非数字（含 NaN）、参数不是数组时抛 TypeError。' }],
            }),
          }
  }
}

/** 剧本的入口：认不出角色时回一段说明文字，平台会把它当成解析失败，E2E 因此失败而不是卡住 */
export function decide(req: Request): Reply {
  const role = roleOf(req)
  if (role === undefined) return { kind: 'text', text: '假模型：认不出角色（feature 模板的角色提示词改过了？要同步改 scripts/fake-model/script.ts）' }
  const turn = turnOf(req)
  const isFirstTurn = !req.messages.slice(0, turn.index).some(m => m.role === 'assistant')
  const plan = turnFor(role, turn.prompt, isFirstTurn)
  return turn.toolsDone.length < plan.tools.length ? plan.tools[turn.toolsDone.length]! : { kind: 'text', text: plan.final }
}
