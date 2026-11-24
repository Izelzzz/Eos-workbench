// 7. 中止。agent 在前台跑一个长命令、在后台再起一个长命令时，平台 abort 这一轮：SDK 调用是否结束，
//    Claude Code 进程、前台命令、后台命令是否都停下（用 ps 按唯一参数核对）。
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseOptions, check, dirs, done, note, run, sessionIdFor } from './common.ts'
import { script } from './upstream.ts'

const d = dirs('c7')
// 孙进程 sleep 也带上唯一参数（第二个 sleep 参数是 0 秒，不影响时长），检查整棵进程树
writeFileSync(join(d.ws, 'hold.sh'), '#!/bin/sh\nsleep 300 "0.$$" 2>/dev/null || sleep 300\n', { mode: 0o755 })
const id = String(process.pid)
const ps = (pat: string) => { try { return execFileSync('pgrep', ['-af', '--', pat], { encoding: 'utf8' }).trim() } catch { return '' } }
const sid = sessionIdFor(`c7/${id}`)
const ac = new AbortController()
let startedFg = 0
let before = { fg: '', bg: '', agent: '' }
const tag = script('c7', [
  () => [{ tool: 'Bash', input: { command: `./hold.sh bg-${id}`, run_in_background: true } }],
  () => [{ tool: 'Bash', input: { command: `./hold.sh fg-${id}`, timeout: 600000 } }],
])
const t0 = Date.now()
const t = await run(tag + `依次用 Bash 执行两条命令：先在后台（run_in_background: true）执行 ./hold.sh bg-${id}，再在前台执行 ./hold.sh fg-${id}（timeout 设为 600000）。不要做别的。`, {
  ...baseOptions(d.home, d.ws), sessionId: sid, tools: ['Bash'], abortController: ac,
  canUseTool: async (_n, i) => ({ behavior: 'allow', updatedInput: i }),
}, m => {
  if (m.type === 'assistant' && (m as any).message.content.some((c: any) => c.type === 'tool_use' && String(c.input?.command).includes(`fg-${id}`)) && !startedFg) {
    startedFg = Date.now()
    setTimeout(() => {
      before = { fg: ps(`fg-${id}`), bg: ps(`bg-${id}`), agent: ps(`--session-id=${sid}`) }
      note('abort 前', Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.split('\n').map(l => l.slice(0, 90))])))
      ac.abort()
    }, 3000)
  }
})
const returnedAfter = Date.now() - t0
note('SDK 调用结束', { ms: returnedAfter, error: t.error?.slice(0, 160), result: t.result?.subtype })
await new Promise(r => setTimeout(r, 3000))
const after = { fg: ps(`fg-${id}`), bg: ps(`bg-${id}`), agent: ps(`--session-id=${sid}`) }
note('abort 3 秒后', after)
check('abort 前三者都在运行', !!(before.fg && before.bg && before.agent), Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v !== ''])))
check('abort 后 SDK 调用很快结束', startedFg > 0 && returnedAfter - (startedFg - t0) < 10000, { startedFg: startedFg - t0, returnedAfter })
check('abort 后 Claude Code 进程停下', after.agent === '', after.agent)
check('abort 后前台命令停下', after.fg === '', after.fg)
check('abort 后后台命令停下', after.bg === '', after.bg)
// 清理：留下的进程由平台负责杀掉
for (const p of [`fg-${id}`, `bg-${id}`, `--session-id=${sid}`]) try { execFileSync('pkill', ['-f', '--', p]) } catch {}
done()
