import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decide, roleOf, type Message, type Request } from '../scripts/fake-model/script.ts'
import { sse } from '../scripts/fake-model/server.ts'
import { parseWorkflow } from '../src/workflow/parse.ts'

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
