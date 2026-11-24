// 4. 崩溃后找回。a：第 1 轮（nonce1）跑完，第 2 轮（nonce2）在 agent 执行 sleep 时宿主进程 SIGKILL 自己。
//    b：新进程不发消息，只读会话记录，按 nonce 找回回复：nonce1 有完整回复，nonce2 判成"没做完，需要重发"。
//    同时把会话记录镜像到平台自己的 SessionStore（这里是数据目录里的 jsonl 文件），对比两边。
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionMessages, query, type SessionStore, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { agentEnv, baseOptions, check, dirs, done, marker, note, sessionIdFor } from './common.ts'
import { script } from './upstream.ts'

const phase = process.argv[2]
const d = dirs('c4', phase === 'a')
const sid = sessionIdFor('task-4/dev')
const storeFile = join(d.root, 'store.jsonl')
// SessionStore 的镜像要求宿主和 agent 进程的 CLAUDE_CONFIG_DIR 一致，否则镜像帧被丢掉。
const configDir = join(d.home, '.claude')
process.env.CLAUDE_CONFIG_DIR = configDir
const store: SessionStore = {
  append: async (key, entries) => { for (const e of entries) appendFileSync(storeFile, JSON.stringify({ key, e }) + '\n') },
  load: async key => {
    if (!existsSync(storeFile)) return null
    const rows = readFileSync(storeFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.key.sessionId === key.sessionId && r.key.subpath === key.subpath)
    return rows.length ? rows.map(r => r.e) : null
  },
}

if (phase === 'a') {
  // Claude Code 会拦下前台的 sleep N，所以用 worktree 里的脚本等待。
  writeFileSync(join(d.ws, 'wait.sh'), '#!/bin/sh\nsleep 30\necho slept\n', { mode: 0o755 })
  const user = (text: string): SDKUserMessage => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
  let next!: () => void
  const turnDone = () => new Promise<void>(r => { next = r })
  async function* input() {
    yield user(script('c4-1', [() => [{ text: '2' }]]) + `1+1 等于几？只回复数字。\n\n${marker('n1')}`)
    await turnDone()
    yield user(script('c4-2', [() => [{ tool: 'Bash', input: { command: './wait.sh' } }], () => [{ text: '完成' }]]) + `用 Bash 执行 ./wait.sh（大约 30 秒），然后回复"完成"。\n\n${marker('n2')}`)
  }
  for await (const m of query({ prompt: input(), options: {
    ...baseOptions(d.home, d.ws), env: agentEnv(d.home, { CLAUDE_CONFIG_DIR: configDir }), sessionId: sid, tools: ['Bash'], sessionStore: store,
    canUseTool: async (_n, i) => ({ behavior: 'allow', updatedInput: i }),
  } })) {
    if (m.type === 'result') { console.log('a: 第 1 轮结束', (m as any).result); next() }
    if (m.type === 'assistant' && (m as any).message.content.some((c: any) => c.type === 'tool_use')) {
      await new Promise(r => setTimeout(r, 2000))
      console.log('a: 第 2 轮 agent 正在执行 sleep，宿主进程 SIGKILL 自己')
      process.kill(process.pid, 'SIGKILL')
    }
  }
} else {
  // agent 进程是否在宿主死后还活着（它可能自己把这一轮跑完）
  const alive = () => { try { return execFileSync('sh', ['-c', `ps -eo pid,args | grep -v grep | grep -E 'wait.sh|claude-agent-sdk' || true`], { encoding: 'utf8' }).trim() } catch { return '' } }
  note('b: 宿主被杀后 agent 进程', alive() || '（没有）')
  await new Promise(r => setTimeout(r, 35000))
  note('b: 35 秒后 agent 进程', alive() || '（没有）')
  // 孤儿进程要由平台清理（这里按会话 id 找）
  try { execFileSync('pkill', ['-f', '--', `--session-id=${sid}`]) } catch {}

  const text = (m: any): string => typeof m.message?.content === 'string' ? m.message.content : (m.message?.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
  const isPrompt = (m: any) => m.type === 'user' && /<!-- eos:[^ ]+ -->/.test(text(m))
  /** findReply：带 nonce 的那条用户消息之后、下一条带 nonce 的消息之前；最后一条 assistant 消息 stop_reason 是 end_turn 才算做完。 */
  const findReply = (msgs: any[], nonce: string) => {
    const at = msgs.findLastIndex(m => m.type === 'user' && text(m).includes(marker(nonce)))
    if (at < 0) return { found: false }
    const rest = msgs.slice(at + 1)
    const range = rest.slice(0, (i => i < 0 ? rest.length : i)(rest.findIndex(isPrompt)))
    const asst = range.filter(m => m.type === 'assistant')
    const last = asst.at(-1)
    const byId = new Map(asst.map(m => [m.message.id, m.message.usage]))
    const usage = [...byId.values()].reduce((u: any, x: any) => ({ input: u.input + (x?.input_tokens ?? 0), output: u.output + (x?.output_tokens ?? 0), cacheRead: u.cacheRead + (x?.cache_read_input_tokens ?? 0), cacheWrite: u.cacheWrite + (x?.cache_creation_input_tokens ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    const complete = last?.message?.stop_reason === 'end_turn'
    return { found: true, complete, text: complete ? text(last) : undefined, usage, model: last?.message?.model, lastStop: last?.message?.stop_reason, entries: range.length }
  }
  const local = await getSessionMessages(sid, { dir: d.ws })
  note('b: 本地会话记录条数', local.length)
  const r1 = findReply(local, 'n1'), r2 = findReply(local, 'n2')
  note('b: nonce1', r1); note('b: nonce2', r2)
  check('b: 按 nonce1 从本地会话记录找回完整回复和用量', r1.complete === true && (r1.text ?? '').includes('2') && (r1.usage as any).output > 0, r1)
  check('b: nonce2 没做完，判成需要重发', r2.found === true && r2.complete === false, r2)
  const mirrored = await getSessionMessages(sid, { sessionStore: store }).catch(e => (note('b: 从 SessionStore 读取失败', String(e)), []))
  const m1 = findReply(mirrored, 'n1')
  note('b: SessionStore 镜像条数 / 本地条数', { mirrored: mirrored.length, local: local.length })
  check('b: 平台的 SessionStore 镜像里也能按 nonce1 找回', m1.complete === true, m1)
  done()
}
