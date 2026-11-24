// 2. 主动提问。agent 调 AskUserQuestion；平台在 canUseTool 里拿到问题和选项，5 秒后（模拟用户）把回答放进 updatedInput.answers，
//    agent 按回答写 color.txt。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseOptions, check, dirs, done, note, run, toolResults } from './common.ts'
import { script } from './upstream.ts'

const d = dirs('c2')
const asked: any[] = []
const tag = script('c2-ask', [
  () => [{ tool: 'AskUserQuestion', input: { questions: [{ question: '用哪种颜色？', header: '颜色', multiSelect: false, options: [{ label: 'red', description: '红色' }, { label: 'blue', description: '蓝色' }] }] } }],
  c => [{ tool: 'Write', input: { file_path: join(d.ws, 'color.txt'), content: /="(\w+)"/.exec(c.lastToolResult)?.[1] ?? "?" } }],
])
const t0 = Date.now()
const t = await run(tag + '先用 AskUserQuestion 工具问我：用 red 还是 blue（两个选项）。拿到回答后，把回答的颜色单词（只有这个单词）写进当前目录的 color.txt，然后结束。', {
  ...baseOptions(d.home, d.ws),
  tools: ['AskUserQuestion', 'Write', 'Read'],
  permissionMode: 'acceptEdits',
  canUseTool: async (name, input) => {
    if (name !== 'AskUserQuestion') return { behavior: 'deny', message: `平台不允许 ${name}` }
    asked.push({ at: Date.now() - t0, input })
    await new Promise(r => setTimeout(r, 5000))
    const qs = (input as any).questions as { question: string }[]
    return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(qs.map(q => [q.question, 'blue'])) } }
  },
})
note('提问内容', asked)
check('平台在 canUseTool 收到结构化问题（带选项）', asked.length === 1 && asked[0].input.questions?.[0]?.options?.length >= 2, asked.map(a => a.input.questions))
note('AskUserQuestion 的工具结果', toolResults(t))
const file = join(d.ws, 'color.txt')
const got = existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
check('agent 按回答继续：color.txt = blue', got === 'blue', { got, result: t.result?.subtype, error: t.error })
done()
