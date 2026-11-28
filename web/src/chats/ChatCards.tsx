import { useState } from 'react'
import { Badge, Button, Card, Field, FieldGroup, FieldLabel, Input, Note, Select, Textarea, cn } from '../ui/index.ts'
import { REPOS, WORKFLOWS, type StageChange, type TaskDraft, type WorkflowChange } from './mock.ts'

/**
 * 对话里等你确认的卡片：和工作台的卡片一样浮起来，没有边框，里面不再套框。
 * 确认或放弃之后收成一行浅底的记录，不再浮着。
 */
function ChatCard({ title, label, open, tail, children }: { title: string; label: string; open: boolean; tail?: React.ReactNode; children: React.ReactNode }) {
  if (!open)
    return (
      <section className="flex min-w-0 flex-col gap-1 rounded-chat bg-fill px-4 py-3">
        <header className="flex min-w-0 items-baseline justify-between gap-3">
          <h3 className="m-0 min-w-0 truncate text-base font-medium text-ink-2">{title}</h3>
          <span className="flex-none text-sm text-ink-3">{label}</span>
        </header>
        {tail}
      </section>
    )
  return (
    <Card className="my-1 gap-4 p-5 pb-4 sm:p-6 sm:pb-5">
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="m-0 min-w-0 truncate text-md font-semibold">{title}</h3>
        <Badge variant="accent">{label}</Badge>
      </header>
      {children}
    </Card>
  )
}

/** 一行标签加内容，不带分隔线 */
const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-4">
    <dt className="w-12 flex-none text-ink-3">{label}</dt>
    <dd className="m-0 min-w-0 flex-1 wrap-anywhere">{children}</dd>
  </div>
)

/** 代理人准备好的任务：可以直接改，点「创建任务」才建 */
export function TaskDraftCard({ draft: initial }: { draft: TaskDraft }) {
  const [state, setState] = useState<'pending' | 'editing' | 'created' | 'dropped'>('pending')
  const [draft, setDraft] = useState(initial)
  const [edit, setEdit] = useState(initial)
  const id = `draft-${initial.title}`
  return (
    <ChatCard
      title={`新任务：${draft.title}`}
      label={{ pending: '待确认', editing: '修改中', created: '已创建', dropped: '没有创建' }[state]}
      open={state === 'pending' || state === 'editing'}
      tail={
        state === 'created' ? (
          <p className="m-0 text-sm text-ink-3">
            进度在{' '}
            <a href="#workbench" className="text-ink-2 underline decoration-ink-3 underline-offset-4 hover:text-ink">
              工作台
            </a>
            。
          </p>
        ) : undefined
      }
    >
      {state === 'editing' ? (
        <>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-repo`}>仓库</FieldLabel>
              <Select id={`${id}-repo`} value={edit.repo} onChange={e => setEdit({ ...edit, repo: e.target.value })}>
                {REPOS.map(r => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-wf`}>工作流</FieldLabel>
              <Select id={`${id}-wf`} value={edit.workflow} onChange={e => setEdit({ ...edit, workflow: e.target.value })}>
                {WORKFLOWS.map(w => (
                  <option key={w}>{w}</option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-need`}>需求</FieldLabel>
              <Textarea id={`${id}-need`} rows={3} value={edit.need} onChange={e => setEdit({ ...edit, need: e.target.value })} />
            </Field>
          </FieldGroup>
          <footer className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setState('pending')}>
              放弃修改
            </Button>
            <Button
              disabled={edit.need.trim() === ''}
              onClick={() => {
                setDraft(edit)
                setState('pending')
              }}
            >
              改好了
            </Button>
          </footer>
        </>
      ) : (
        <>
          <dl className="m-0 flex flex-col gap-2">
            <Row label="仓库">{draft.repo}</Row>
            <Row label="工作流">{draft.workflow}</Row>
            <Row label="需求">{draft.need}</Row>
          </dl>
          <footer className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="ghost" className="-ml-4" onClick={() => setState('dropped')}>
              不创建
            </Button>
            <span className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEdit(draft)
                  setState('editing')
                }}
              >
                修改
              </Button>
              <Button onClick={() => setState('created')}>创建任务</Button>
            </span>
          </footer>
        </>
      )}
    </ChatCard>
  )
}

export const isChanged = (s: StageChange) => s.summary !== undefined
const KIND = { added: '新增', removed: '删除', changed: '修改' } as const

type ChangeProps = {
  change: WorkflowChange
  /** 让代理人按这句话重新提一版 */
  onRevise: (text: string) => void
  /** 在画板里看整个流程 */
  onCanvas: () => void
}

/**
 * 代理人提议的修改（工作流、Agent 模板）。卡片里只列改到的阶段，一处一行；
 * 整个流程长什么样去画板里看。可以让它再改，点「保存」才生效；放宽权限时要多确认一步。
 */
export function WorkflowChangeCard({ change, onRevise, onCanvas }: ChangeProps) {
  const [state, setState] = useState<'pending' | 'revising' | 'saved' | 'dropped' | 'replaced'>('pending')
  const [agreed, setAgreed] = useState(false)
  const [ask, setAsk] = useState('')
  const open = state === 'pending' || state === 'revising'
  const label = { pending: '待确认', revising: '待确认', saved: `已保存为第 ${change.nextVersion} 版`, dropped: '没有保存', replaced: '已经有新的一版' }[state]
  const changed = change.stages.filter(isChanged)
  const before = (s: StageChange) => change.stages.slice(0, change.stages.indexOf(s)).findLast(x => x.change !== 'removed')?.stage
  const submit = () => {
    const text = ask.trim()
    if (text === '') return
    setState('replaced')
    onRevise(text)
  }
  return (
    <ChatCard title={`修改：${change.name}`} label={label} open={open}>
      <p className="m-0 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-3">
        <span>
          {change.stages.length} 个阶段，改了 {changed.length} 个
        </span>
        <Button variant="link" className="h-auto px-0 text-sm text-ink-2" onClick={onCanvas}>
          在画板里看整个流程
        </Button>
      </p>
      <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
        {changed.map(s => (
          <li key={s.stage} className="flex min-w-0 gap-3">
            <Badge variant="neutral" className="mt-0.5 flex-none">
              {KIND[s.change ?? 'changed']}
            </Badge>
            <div className="flex min-w-0 flex-col">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className={cn('font-medium', s.change === 'removed' && 'text-ink-3 line-through')}>{s.stage}</span>
                <span className="text-sm text-ink-3">{s.change === 'added' ? `在${before(s) ?? '最前面'}之后` : s.change === 'removed' ? '' : s.summary}</span>
              </span>
              <span className="wrap-anywhere text-ink-2">{s.detail}</span>
            </div>
          </li>
        ))}
      </ul>
      {change.widens !== undefined && (
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
      {state === 'revising' && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`ask-${change.name}`} className="text-sm text-ink-2">
            哪里要改？代理人会按你说的重新提一版。
          </label>
          <div className="flex gap-2">
            <Input
              id={`ask-${change.name}`}
              autoFocus
              placeholder="例如：评审保留 5 轮"
              value={ask}
              onChange={e => setAsk(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submit()
              }}
            />
            <Button disabled={ask.trim() === ''} onClick={submit}>
              让它重提
            </Button>
          </div>
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" className="-ml-4" onClick={() => setState('dropped')}>
          不保存
        </Button>
        <span className="flex flex-wrap gap-2">
          <Button variant="outline" aria-expanded={state === 'revising'} onClick={() => setState(state === 'revising' ? 'pending' : 'revising')}>
            修改
          </Button>
          <Button disabled={change.widens !== undefined && !agreed} onClick={() => setState('saved')}>
            保存
          </Button>
        </span>
      </footer>
    </ChatCard>
  )
}
