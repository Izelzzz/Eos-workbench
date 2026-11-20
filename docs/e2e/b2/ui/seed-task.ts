// 在 E2E 用的数据目录里放一个任务，带上「创建时用了哪些约定版本」，用来看任务页的显示。
// 不调用模型：直接写 store（任务停在第一步）。由 ui-e2e.ts 调用，也可以单独跑。
import { join, resolve } from 'node:path'
import { Conventions } from '../../../../src/conventions/conventions.ts'
import { Store } from '../../../../src/store/store.ts'

const dir = resolve(import.meta.dirname, '../../../..', process.env.EOS_E2E_DATA ?? '.eos/t4')
const store = new Store(join(dir, 'eos.db'))
const r = new Conventions(store).resolve('audit')
if (!r.ok) throw new Error(r.error)
store.create({
  id: 'demo-1', request: '核对上一轮改动是否满足规格', workflow: r.workflow, workflowSource: r.source, docs: r.docs,
  meta: { repo: '/home/you/project', worktree: join(dir, 'worktrees', 'demo-1'), branch: 'eos/demo-1', baseSha: 'abc1234', conventions: r.used },
}, Date.now())
console.log(`任务 demo-1 用到的约定版本：${JSON.stringify(r.used)}`)
