// 由 agent-user-probe.ts 拷进旧镜像（③c 之前，dsh 以 eos 运行）里运行：用当时的 DshExecutor 打开一个会话，不调用模型，
// 留下升级前的 dsh 数据目录，供新镜像迁移、续接。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DshExecutor, dshInstall } from '../src/executor/dsh.ts'

const cwd = '/data/worktrees/upgrade-task'
mkdirSync(cwd, { recursive: true })
const ex = new DshExecutor({ dshHome: '/data/dsh', dshBin: dshInstall(join(import.meta.dirname, '..'))!.bin, modelKey: () => 'sk-probe-old-key' })
const spec = { model: 'deepseek-flash', write: 'worktree' as const, cwd, profile: { denyTools: [], skills: [], mcp: [], background: true } }
await (ex as unknown as { session: (key: string, s: typeof spec) => Promise<unknown> }).session(process.argv[2]!, spec)
await ex.close()
console.log('ok')
