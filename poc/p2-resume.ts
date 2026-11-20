// PoC 2: session survives a hard kill of the dsh process; resume continues the conversation.
import { make } from './common.ts'
import { writeFileSync, readFileSync } from 'node:fs'
const step = process.argv[2]
if (step === 'a') {
  const h = make()
  const r = await h.run('记住暗号：紫色长颈鹿-4721。只回复"已记住"。')
  writeFileSync(process.env.POC + '/sid.txt', r.sessionId)
  console.log('A', r.sessionId, r.finalResponse)
  process.kill(process.pid, 'SIGKILL') // hard kill host; the dsh child is orphaned and dies on stdin EOF
} else {
  await using h = make()
  const sid = readFileSync(process.env.POC + '/sid.txt', 'utf8')
  const s = await h.resumeSession(sid)
  const r = await s.run('刚才的暗号是什么？只回复暗号。')
  console.log('B', r.sessionId === sid, r.finalResponse)
}
