import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decide, roleOf, type Message, type Request } from '../scripts/fake-model/script.ts'
import { sse } from '../scripts/fake-model/server.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'
import { critiquePrompt } from '../src/engine/prompts.ts'
import { newTask } from '../src/engine/machine.ts'
import type { DialogNode } from '../src/workflow/types.ts'

const ROOT = join(import.meta.dirname, '..')
const prompt = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })
const called = (name: string, id: string): Message[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] },
]
const answered = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })
const req = (...messages: Message[]): Request => ({ model: 'deepseek-flash', messages })

const ROLE = {
  planner: '# 你的角色\n\n你是资深技术负责人，负责把需求整理成可执行、可验证的方案。',
  developer: '# 你的角色\n\n你是严谨的软件工程师，在当前目录里按方案实现需求。',
  reviewer: '# 你的角色\n\n你是独立的代码评审者，没有参与开发。',
}

test('角色按 feature 模板里各角色提示词的开头认；模板改了提示词时这里先失败', () => {
  const template = parseWorkflow(readFileSync(join(ROOT, 'src/workflow/templates/feature.yaml'), 'utf8'))
  assert.ok(template.ok, JSON.stringify(template))
  for (const [role, def] of Object.entries(template.workflow.roles)) {
    assert.equal(roleOf(req(prompt(`# 你的角色\n\n${def.prompt}`))), role, role)
  }
  assert.equal(roleOf(req(prompt('随便什么'))), undefined)
})

test('规划：先用 ask_user_question 提问（第一个选项是 sum），收到回答后给方案', () => {
  const first = decide(req(prompt(ROLE.planner)))
  assert.equal(first.kind === 'tool' && first.name, 'ask_user_question')
  assert.deepEqual(first.kind === 'tool' && (first.input.questions as { options: { label: string }[] }[])[0]!.options[0], { label: 'sum' })
  const then = decide(req(prompt(ROLE.planner), ...called('ask_user_question', 't1')))
  assert.equal(then.kind, 'text')
  assert.match(then.kind === 'text' ? then.text : '', /验收标准/)
})

test('开发：第一轮写实现、写测试、跑测试再回复；评审意见那一轮补测试、跑测试再回复', () => {
  const steps = (history: Message[], n: number) => {
    const out: string[] = []
    let h = history
    for (let i = 0; i < n; i++) {
      const r = decide(req(...h))
      out.push(r.kind === 'tool' ? `${r.name}:${String(r.input.file_path ?? r.input.command)}` : 'text')
      if (r.kind === 'tool') h = [...h, ...called(r.name, `t${i}`)]
    }
    return { out, h }
  }
  const first = steps([prompt(ROLE.developer)], 4)
  assert.deepEqual(first.out, ['write:src/math.js', 'write:test/math.test.js', 'bash:npm test', 'text'])
  const second = steps([...first.h, answered('改好了'), prompt('# 第 1 轮：review 的意见\n\n补测试')], 3)
  assert.deepEqual(second.out, ['write:test/math.test.js', 'bash:npm test', 'text'])
})

test('评审：第一次打回（major），之后的轮次通过；结论是平台要求的 JSON 代码块', () => {
  const verdictOf = (r: ReturnType<typeof decide>) => JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.kind === 'text' ? r.text : '')![1]!)
  const initial = [prompt(`${ROLE.reviewer}\n\n# 待评审：build 的说明`), ...called('bash', 'a'), ...called('bash', 'b')]
  const v1 = verdictOf(decide(req(...initial)))
  assert.equal(v1.verdict, 'changes')
  assert.equal(v1.issues[0].severity, 'major')
  const round2 = [...initial, answered('...'), prompt('# 第 1 轮：build 的回复\n\n补了'), ...called('bash', 'c')]
  assert.equal(verdictOf(decide(req(...round2))).verdict, 'pass')
})

test('认不出角色时回一段说明文字，不调工具', () => {
  const r = decide(req(prompt('别的模板')))
  assert.equal(r.kind, 'text')
  assert.match(r.kind === 'text' ? r.text : '', /认不出角色/)
})

test('SSE：工具调用以 tool_use 结束，文字以 end_turn 结束；每个事件的 event 名和 data 里的 type 一致', () => {
  const events = (s: string) =>
    s
      .trim()
      .split('\n\n')
      .map(f => {
        const [e, d] = f.split('\n')
        const data = JSON.parse(d!.slice('data: '.length))
        assert.equal(e!.slice('event: '.length), data.type)
        return data
      })
  const t = events(sse({ kind: 'tool', name: 'write', input: { file_path: 'a', content: 'b' } }, '1'))
  assert.equal(t.at(-2).delta.stop_reason, 'tool_use')
  assert.deepEqual(JSON.parse(t.find(e => e.delta?.type === 'input_json_delta').delta.partial_json), { file_path: 'a', content: 'b' })
  assert.equal(events(sse({ kind: 'text', text: 'x' }, '2')).at(-2).delta.stop_reason, 'end_turn')
})

test('评审：用平台真正发的提示词，会话第一轮打回，复核和方案重新确认之后的轮次通过', () => {
  const parsed = parseWorkflow(readFileSync(join(ROOT, 'src/workflow/templates/feature.yaml'), 'utf8'))
  assert.ok(parsed.ok)
  const base = newTask({ id: 't', request: '写 sum', workflow: parsed.workflow, docs: [] }, 0)
  const task = { ...base, outputs: { ...base.outputs, plan: '方案', build: '实现了 sum' } }
  const review = parsed.workflow.nodes.find(n => n.id === 'review') as DialogNode
  /** 跑完这一轮（先做完剧本里的工具调用），返回历史和结论 */
  const finish = (h: Message[]) => {
    for (let i = 0; i < 5; i++) {
      const r = decide(req(...h))
      if (r.kind === 'text') return { h: [...h, answered(r.text)], verdict: JSON.parse(/```json\n([\s\S]*)\n```/.exec(r.text)![1]!).verdict }
      h = [...h, ...called(r.name, `t${h.length}`)]
    }
    throw new Error('这一轮没有给出结论')
  }
  const first = finish([prompt(critiquePrompt(task, review, 'first'))])
  assert.equal(first.verdict, 'changes')
  const reply = finish([...first.h, prompt(critiquePrompt(task, review, 'reply'))])
  assert.equal(reply.verdict, 'pass')
  assert.equal(finish([...reply.h, prompt(critiquePrompt(task, review, 'revised'))]).verdict, 'pass')
})

test('dsh 没提供剧本要用的工具时说明是哪个，不往下走；工具结果旁边附的文字不算新的一轮', () => {
  const r = decide({ model: 'm', messages: [prompt(ROLE.planner)], tools: [{ name: 'bash' }] })
  assert.match(r.kind === 'text' ? r.text : '', /没有提供 ask_user_question/)
  const withNote: Message = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'w', content: [] },
      { type: 'text', text: '（提醒：文件已写入）' },
    ],
  }
  const next = decide(req(prompt(ROLE.developer), { role: 'assistant', content: [{ type: 'tool_use', id: 'w', name: 'write', input: {} }] }, withNote))
  assert.equal(next.kind === 'tool' && next.input.file_path, 'test/math.test.js')
})

// ---- Claude Code 发来的请求：工具名大写开头，Write 要绝对路径，工作目录写在请求里 ----

const CC_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'AskUserQuestion'].map(name => ({ name }))
const ccReq = (...messages: Message[]): Request => ({
  model: 'claude-sonnet-5-5',
  messages,
  tools: CC_TOOLS,
  system: [{ type: 'text', text: 'Environment:\n - Primary working directory: /data/worktrees/t1\n' }],
})

test('Claude Code：同一个剧本换成它的工具名和参数——Write 用绝对路径，Bash 原样，提问带 header 和选项说明', () => {
  const ask = decide(ccReq(prompt(ROLE.planner)))
  assert.equal(ask.kind === 'tool' && ask.name, 'AskUserQuestion')
  assert.deepEqual(ask.kind === 'tool' && ask.input, {
    questions: [
      {
        question: '函数名用 sum 还是 total？',
        header: '问题',
        multiSelect: false,
        options: [
          { label: 'sum', description: 'sum' },
          { label: 'total', description: 'total' },
        ],
      },
    ],
  })
  const steps: string[] = []
  let h: Message[] = [prompt(ROLE.developer)]
  for (let i = 0; i < 4; i++) {
    const r = decide(ccReq(...h))
    steps.push(r.kind === 'tool' ? `${r.name}:${String(r.input.file_path ?? r.input.command)}` : 'text')
    if (r.kind === 'tool') h = [...h, ...called(r.name, `c${i}`)]
  }
  assert.deepEqual(steps, ['Write:/data/worktrees/t1/src/math.js', 'Write:/data/worktrees/t1/test/math.test.js', 'Bash:npm test', 'text'])
})

test('Claude Code：请求里找不到工作目录时说明原因，不往下走；dsh 的请求照旧用 dsh 的工具名', () => {
  const r = decide({ ...ccReq(prompt(ROLE.developer)), system: [] })
  assert.match(r.kind === 'text' ? r.text : '', /找不到工作目录/)
  const dsh = decide({ model: 'm', messages: [prompt(ROLE.developer)], tools: [{ name: 'write' }, { name: 'bash' }] })
  assert.deepEqual(dsh.kind === 'tool' && [dsh.name, dsh.input.file_path], ['write', 'src/math.js'])
})
