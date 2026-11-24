// 以 root 启动的平台通过它起 dsh：先切到 agent 用户，再加载真正的 dsh 入口。
const uid = Number(process.env.EOS_AGENT_UID ?? 1001)
process.setgroups([]); process.setgid(uid); process.setuid(uid)
if (process.getuid() !== uid || process.geteuid() !== uid) throw new Error('降权失败')
const { runCli } = await import('/app/node_modules/@deepseek-ai/dsh/lib/bin.js')
await runCli()
