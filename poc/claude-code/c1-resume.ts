// 1. 会话续接。a：同一个 Claude Code 进程里两轮（流式输入），第二轮要答出第一轮的暗号，然后宿主进程 SIGKILL 自己。
//    b：新的宿主进程用 resume 接回同一个会话 id，再问暗号。
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { baseOptions, check, dirs, done, finalText, note, run, sessionIdFor } from './common.ts'
import { script } from './upstream.ts'

const phase = process.argv[2]
const d = dirs('c1', phase === 'a')
const sid = sessionIdFor('task-1/dev')
const recall = script('c1-recall', [c => [{ text: /EOS-[A-Z0-9]{6}/.exec(c.allText)?.[0] ?? '不知道' }]])
const opts = { ...baseOptions(d.home, d.ws), tools: [] as string[] }

if (phase === 'a') {
  const code = 'EOS-' + randomBytes(3).toString('hex').toUpperCase()
  writeFileSync(join(d.root, 'codeword'), code)
  const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  let next!: () => void
  const turnDone = () => new Promise<void>(r => { next = r })
  async function* input() {
    yield user(script('c1-remember', [() => [{ text: '记住了' }]]) + `请记住暗号 ${code}，只回复"记住了"。`)
    await turnDone()
    yield user(recall + '刚才的暗号是什么？只回复暗号本身。')
  }
  const results: any[] = []
  let pid: number | undefined
  for await (const m of query({ prompt: input(), options: { ...opts, sessionId: sid } })) {
    if (m.type === 'system' && m.subtype === 'init') note('init', { session_id: m.session_id, cwd: m.cwd })
    if (m.type === 'result') { results.push(m); if (results.length === 1) next(); else break }
  }
  check('a: 会话 id 是平台指定的', results.every(r => r.session_id === sid), results.map(r => r.session_id))
  check('a: 同一进程第二轮记得暗号', (results[1]?.result ?? '').includes(code), { code, reply: results[1]?.result })
  const transcript = join(d.home, '.claude', 'projects', d.ws.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
  check('a: 会话记录写在 agent 的 HOME 下', existsSync(transcript), transcript)
  console.log('a: 宿主进程 SIGKILL 自己')
  process.kill(process.pid, 'SIGKILL')
} else {
  const code = readFileSync(join(d.root, 'codeword'), 'utf8')
  const t = await run(recall + '我们之前约定的暗号是什么？只回复暗号本身。', { ...opts, resume: sid })
  check('b: 新进程续接的是同一个会话', t.result?.session_id === sid, t.result?.session_id)
  check('b: 新进程续接后记得暗号', (finalText(t) ?? '').includes(code), { code, reply: finalText(t), error: t.error })
  const t2 = await run(recall + '暗号？', { ...opts, sessionId: sid })
  note('b: 已存在的会话 id 再用 sessionId 新建', { error: t2.error?.slice(0, 200), reply: finalText(t2) })
  done()
}
