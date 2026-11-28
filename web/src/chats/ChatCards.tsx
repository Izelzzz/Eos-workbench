import { useState } from 'react'
import { Badge, Button, InfoList, InfoRow, Note, cn } from '../ui/index.ts'
import { STAGES, type TaskDraft, type WorkflowChange } from './mock.ts'

/** 对话里的卡片：细边框、没有阴影（一屏只有一个浮起来的东西，对话里不用 Card） */
function ChatCard({ title, state, children }: { title: string; state: { label: string; waiting: boolean }; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-chat border border-line p-4">
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="m-0 min-w-0 truncate text-lead font-semibold">{title}</h3>
        <Badge variant={state.waiting ? 'accent' : 'neutral'}>{state.label}</Badge>
      </header>
      {children}
    </section>
  )
}

/** 代理人准备好的任务：你点「创建任务」才建 */
export function TaskDraftCard({ draft }: { draft: TaskDraft }) {
  const [state, setState] = useState<'pending' | 'created' | 'dropped'>('pending')
  return (
    <ChatCard title={`新任务：${draft.title}`} state={{ label: { pending: '待确认', created: '已创建', dropped: '没有创建' }[state], waiting: state === 'pending' }}>
      <InfoList>
        <InfoRow label="仓库">{draft.repo}</InfoRow>
        <InfoRow label="工作流">{draft.workflow}</InfoRow>
        <InfoRow label="需求">{draft.need}</InfoRow>
      </InfoList>
      {state === 'pending' && (
        <footer className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => setState('dropped')}>
            不创建
          </Button>
          <Button onClick={() => setState('created')}>创建任务</Button>
        </footer>
      )}
      {state === 'created' && (
        <p className="m-0 text-sm text-ink-2">
          任务开始了，进度在{' '}
          <a href="#workbench" className="text-ink underline decoration-ink-3 underline-offset-4 hover:decoration-ink">
            工作台
          </a>
          。
        </p>
      )}
    </ChatCard>
  )
}

/** 代理人提议的修改（工作流、Agent 模板）：先看改了哪里，点「保存」才生效；放宽权限时要多确认一步 */
export function WorkflowChangeCard({ change }: { change: WorkflowChange }) {
  const [state, setState] = useState<'pending' | 'saved' | 'dropped'>('pending')
  const [agreed, setAgreed] = useState(false)
  const [full, setFull] = useState(false)
  const changed = change.stages.filter(s => s.summary !== undefined)
  return (
    <ChatCard
      title={`修改：${change.name}`}
      state={{ label: { pending: '待确认', saved: `已保存为第 ${change.nextVersion} 版`, dropped: '没有保存' }[state], waiting: state === 'pending' }}
    >
      <ol className="m-0 grid list-none grid-cols-5 gap-1.5 p-0">
        {STAGES.map(name => {
          const s = change.stages.find(x => x.stage === name)
          const on = s?.summary !== undefined
          return (
            <li key={name} className={cn('flex min-w-0 flex-col items-center rounded-lg border border-line px-1 py-2 text-center text-sm text-ink-3', on && 'border-ink text-ink shadow-selected')}>
              <span className={cn(on && 'font-medium')}>{name}</span>
              {on && <span className="text-xs text-ink-2">{s.summary}</span>}
            </li>
          )
        })}
      </ol>
      <InfoList>
        {changed.map(s => (
          <InfoRow key={s.stage} label={s.stage}>
            {s.detail}
          </InfoRow>
        ))}
      </InfoList>
      {full && <pre className="m-0 overflow-x-auto rounded-box bg-fill p-3 font-mono text-code text-ink-2">{`# 这里是完整的文本差异\n- max_rounds: 5\n+ max_rounds: 3`}</pre>}
      {change.widens !== undefined && state === 'pending' && (
        <Note className="flex flex-col gap-2">
          <span>
            <b>这次修改会放宽权限。</b>
            {change.widens}
          </span>
          <label className="flex cursor-pointer items-center gap-2 text-ink">
            <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} className="size-4 accent-ink" />
            我看过上面的权限改动，确认要这样改
          </label>
        </Note>
      )}
      {state === 'pending' && (
        <footer className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="link" className="px-0" onClick={() => setFull(!full)}>
            {full ? '收起完整差异' : '查看完整差异'}
          </Button>
          <span className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setState('dropped')}>
              不保存
            </Button>
            <Button disabled={change.widens !== undefined && !agreed} onClick={() => setState('saved')}>
              保存
            </Button>
          </span>
        </footer>
      )}
    </ChatCard>
  )
}
