// PoC 3: agent proactively asks the user; host receives the structured question, answers later, agent continues.
import { make, tools } from './common.ts'
import { existsSync, readFileSync, rmSync } from 'node:fs'
rmSync(process.env.POC + '/ws/color.txt', { force: true })
const asked: any[] = []
await using h = make({ onUserQuestion: async (req: any) => {
  asked.push(req.questions)
  await new Promise(r => setTimeout(r, 3000)) // user takes a while
  const q = req.questions[0]
  return { answers: [{ id: q.id, selected: [q.options?.[1]?.label ?? '绿色'] }] }
} })
const r = await h.run('需求有歧义：我没说配色。请先用 ask_user_question 工具问我要红色还是绿色（给两个选项），拿到答案后把颜色名写进当前目录的 color.txt，然后结束。')
console.log(JSON.stringify({ asked, tools: tools(r), final: r.finalResponse,
  file: existsSync(process.env.POC + '/ws/color.txt') ? readFileSync(process.env.POC + '/ws/color.txt', 'utf8') : null }, null, 1))
