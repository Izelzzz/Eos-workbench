// 6. 技能、MCP、指令文件。
//   a：按会话挂一个本地插件（里面一个技能）和一个 stdio MCP 服务，agent 能用上；看技能列表里还有没有别的技能。
//   b：worktree 和 HOME 里放带暗号的 CLAUDE.md / AGENTS.md / 仓库技能，对比默认（不传 settingSources）和 settingSources: [] 时，
//      暗号有没有出现在真正发给模型的请求里。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { baseOptions, check, dirs, done, finalText, note, run, toolResults } from './common.ts'
import { requests, script } from './upstream.ts'

const sent = (from: number) => JSON.stringify(requests.slice(from))

// ---- a 技能和 MCP ----
{
  const d = dirs('c6a')
  const plugin = join(d.root, 'plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true }); mkdirSync(join(plugin, 'skills', 'codeword'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'eos', version: '0.0.0', description: '平台给这个角色的技能' }))
  writeFileSync(join(plugin, 'skills', 'codeword', 'SKILL.md'), '---\nname: codeword\ndescription: 用户问"技能暗号"时使用\n---\n技能暗号是 SK-7Q2W。\n')
  const tag = script('c6-a', [
    () => [{ tool: 'Skill', input: { skill: 'eos:codeword' } }],
    () => [{ tool: 'mcp__eos__get_codeword', input: {} }],
    () => [{ tool: 'Skill', input: { skill: 'dataviz' } }],
    c => [{ text: [/SK-\w{4}/.exec(c.allText)?.[0], /MC-\w{4}/.exec(c.allText)?.[0]].join(' ') }],
  ])
  const from = requests.length
  const t = await run(tag + '先调用 eos:codeword 技能拿到技能暗号，再调用 MCP 工具 mcp__eos__get_codeword 拿到 MCP 暗号，然后尝试调用 dataviz 技能（失败也没关系），最后只回复这两个暗号，用空格隔开。', {
    ...baseOptions(d.home, d.ws),
    tools: ['Read', 'Skill'],
    plugins: [{ type: 'local', path: plugin }],
    skills: ['eos:codeword'],
    mcpServers: { eos: { type: 'stdio', command: process.execPath, args: [resolve('mcp-server.mjs'), 'MC-9K3D'], env: {} } },
    canUseTool: async (_n, i) => ({ behavior: 'allow', updatedInput: i }),
  })
  note('a init.skills / plugins / mcp_servers', { skills: t.init?.skills, plugins: t.init?.plugins, mcp: t.init?.mcp_servers })
  note('a 发给模型的工具表', (requests.at(-1)?.tools ?? []).map((x: any) => x.name))
  note('a 工具结果', toolResults(t).map(r => r.text.slice(0, 120)))
  check('a 按会话挂的插件技能能用（技能内容进了上下文）', sent(from).includes('SK-7Q2W') && (finalText(t) ?? '').includes('SK-7Q2W'), finalText(t))
  check('a 按会话挂的 stdio MCP 服务能用', toolResults(t).some(r => r.text.includes('MC-9K3D')) && (finalText(t) ?? '').includes('MC-9K3D'), finalText(t))
  note('a init.skills 仍列出自带技能（skills 选项只过滤模型看到的列表）', t.init?.skills)
  // 看这一轮的全部请求；正向条件用技能自己的说明文字（提示词里没有这句话），证明技能列表确实在请求里
  const all = sent(from)
  check('a 发给模型的技能列表里有平台给的技能，没有自带技能（claude-api、update-config）', !/claude-api|update-config/.test(all) && all.includes('用户问\\"技能暗号\\"时使用'), { requests: requests.length - from, listed: all.includes('用户问\\"技能暗号\\"时使用'), claudeApi: all.includes('claude-api'), updateConfig: all.includes('update-config') })
  check('a 调用没给的技能被拒绝', toolResults(t).filter(r => r.isError).length >= 1, toolResults(t).map(r => ({ e: r.isError, t: r.text.slice(0, 100) })))
}

// ---- b 指令文件 ----
{
  const d = dirs('c6b')
  writeFileSync(join(d.ws, 'CLAUDE.md'), '仓库 CLAUDE.md 暗号：WS-CLAUDE-31\n')
  writeFileSync(join(d.ws, 'AGENTS.md'), '仓库 AGENTS.md 暗号：WS-AGENTS-32\n')
  mkdirSync(join(d.home, '.claude'), { recursive: true })
  writeFileSync(join(d.home, '.claude', 'CLAUDE.md'), '用户目录 CLAUDE.md 暗号：HOME-CLAUDE-33\n')
  mkdirSync(join(d.ws, '.claude', 'skills', 'repo-skill'), { recursive: true })
  writeFileSync(join(d.ws, '.claude', 'skills', 'repo-skill', 'SKILL.md'), '---\nname: repo-skill\ndescription: 仓库技能 WS-SKILL-34\n---\nx\n')
  writeFileSync(join(d.ws, '.claude', 'settings.json'), JSON.stringify({ env: { EOS_FROM_REPO_SETTINGS: 'WS-SETTINGS-35' } }))
  const codes = ['WS-CLAUDE-31', 'WS-AGENTS-32', 'HOME-CLAUDE-33', 'WS-SKILL-34']
  const probe = async (label: string, extra: object) => {
    const from = requests.length
    const t = await run(script(`c6-b-${label}`, [() => [{ text: 'ok' }]]) + '你的指令里有哪些暗号？逐个列出，没有就回复"没有"。', { ...baseOptions(d.home, d.ws), tools: ['Read', 'Skill'], ...extra })
    const found = codes.filter(c => sent(from).includes(c))
    note(`b ${label}：请求里出现的暗号`, found)
    note(`b ${label}：init.skills`, t.init?.skills)
    note(`b ${label}：模型回复`, finalText(t))
    return found
  }
  const { settingSources: _, ...noSources } = baseOptions(d.home, d.ws)
  const dflt = await probe('默认', { ...noSources, settingSources: undefined })
  const off = await probe('settingSources=[]', { settingSources: [] })
  check('b 默认会读仓库和用户目录的指令文件', dflt.length > 0, dflt)
  check('b settingSources: [] 之后一个都不读', off.length === 0, off)
}
done()
