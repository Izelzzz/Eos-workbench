import { useState } from 'react'
import { Badge, Button, Field, FieldGroup, FieldLabel, InfoList, InfoRow, Input, Note, Select, Textarea, cn } from '../ui/index.ts'
import { REPOS, WORKFLOWS, type StageChange, type TaskDraft, type WorkflowChange } from './mock.ts'

/** 对话里的卡片：细边框、没有阴影（一屏只有一个浮起来的东西，对话里不用 Card） */
function ChatCard({ title, state, children }: { title: string; state: { label: string; waiting: boolean }; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3.5 rounded-chat border border-line p-4">
      <header className="flex min-w-0 items-baseline justify-between gap-3">
        <h3 className="m-0 min-w-0 truncate text-lead font-semibold">{title}</h3>
        <Badge variant={state.waiting ? 'accent' : 'neutral'}>{state.label}</Badge>
      </header>
      {children}
    </section>
  )
}

/** 代理人准备好的任务：可以直接改，点「创建任务」才建 */
export function TaskDraftCard({ draft: initial }: { draft: TaskDraft }) {
  const [state, setState] = useState<'pending' | 'editing' | 'created' | 'dropped'>('pending')
  const [draft, setDraft] = useState(initial)
  const [edit, setEdit] = useState(initial)
  const id = `draft-${initial.title}`
  return (
    <ChatCard title={`新任务：${draft.title}`} state={{ label: { pending: '待确认', editing: '修改中', created: '已创建', dropped: '没有创建' }[state], waiting: state === 'pending' || state === 'editing' }}>
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
            <Button variant="outline" onClick={() => setState('pending')}>
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
        <InfoList>
          <InfoRow label="仓库">{draft.repo}</InfoRow>
          <InfoRow label="工作流">{draft.workflow}</InfoRow>
          <InfoRow label="需求">{draft.need}</InfoRow>
        </InfoList>
      )}
      {state === 'pending' && (
        <footer className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => setState('dropped')}>
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

const isChanged = (s: StageChange) => s.summary !== undefined

/**
 * 阶段图：一行连起来的阶段，改到的突出显示。
 * 阶段多的时候（超过 6 个），连续两个以上没改的阶段收成一个「N 个没改」，点了展开；一行放不下就折行。
 */
function StageFlow({ stages }: { stages: StageChange[] }) {
  const [open, setOpen] = useState(false)
  const long = stages.length > 6
  type Item = { kind: 'stage'; stage: StageChange } | { kind: 'gap'; names: string[] }
  const items: Item[] = []
  for (let i = 0; i < stages.length; ) {
    let j = i
    while (j < stages.length && !isChanged(stages[j]!)) j++
    const run = stages.slice(i, j)
    if (long && !open && run.length >= 2) items.push({ kind: 'gap', names: run.map(s => s.stage) })
    else for (const s of run) items.push({ kind: 'stage', stage: s })
    if (j < stages.length) items.push({ kind: 'stage', stage: stages[j]! })
    i = j + 1
  }
  const changed = stages.filter(isChanged).length
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <p className="m-0 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-3">
        <span>
          {stages.length} 个阶段，改了 {changed} 个
        </span>
        {long && open && (
          <Button variant="link" className="h-auto px-0 text-sm text-ink-2" onClick={() => setOpen(false)}>
            收起没改的
          </Button>
        )}
      </p>
      <ol className="m-0 flex list-none flex-wrap items-center gap-y-2 p-0">
        {items.map((it, i) => (
          <li key={it.kind === 'stage' ? it.stage.stage : `gap-${i}`} className="flex items-center">
            {i > 0 && <span aria-hidden="true" className="h-px w-3 flex-none bg-line" />}
            {it.kind === 'gap' ? (
              <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`展开 ${it.names.length} 个没改的阶段：${it.names.join('、')}`} className="h-7 rounded-full px-2.5 text-ink-3">
                {it.names.length} 个没改
              </Button>
            ) : isChanged(it.stage) ? (
              <span
                className={cn(
                  'flex flex-col rounded-control border px-3 py-1.5',
                  it.stage.change === 'removed' ? 'border-line' : 'border-ink shadow-selected',
                  it.stage.change === 'added' && 'border-dashed shadow-none',
                )}
              >
                <span className={cn('text-sm font-medium text-ink', it.stage.change === 'removed' && 'text-ink-3 line-through')}>{it.stage.stage}</span>
                <span className="text-xs text-ink-2">{it.stage.summary}</span>
              </span>
            ) : (
              <span className="flex items-center gap-1.5 px-1.5 text-sm text-ink-3">
                <span aria-hidden="true" className="size-1.5 flex-none rounded-full border border-ink-3" />
                {it.stage.stage}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

type ChangeProps = {
  change: WorkflowChange
  /** 让代理人按这句话重新提一版 */
  onRevise: (text: string) => void
}

/** 代理人提议的修改（工作流、Agent 模板）：先看改了哪里，可以让它再改，点「保存」才生效；放宽权限时要多确认一步 */
export function WorkflowChangeCard({ change, onRevise }: ChangeProps) {
  const [state, setState] = useState<'pending' | 'revising' | 'saved' | 'dropped' | 'replaced'>('pending')
  const [agreed, setAgreed] = useState(false)
  const [full, setFull] = useState(false)
  const [ask, setAsk] = useState('')
  const open = state === 'pending' || state === 'revising'
  const label = { pending: '待确认', revising: '待确认', saved: `已保存为第 ${change.nextVersion} 版`, dropped: '没有保存', replaced: '已经有新的一版' }[state]
  const submit = () => {
    const text = ask.trim()
    if (text === '') return
    setState('replaced')
    onRevise(text)
  }
  return (
    <ChatCard title={`修改：${change.name}`} state={{ label, waiting: open }}>
      <StageFlow stages={change.stages} />
      <InfoList>
        {change.stages.filter(isChanged).map(s => (
          <InfoRow key={s.stage} label={s.stage}>
            {s.detail}
          </InfoRow>
        ))}
      </InfoList>
      {full && <pre className="m-0 overflow-x-auto rounded-box bg-fill p-3 font-mono text-code text-ink-2">{`# 这里是完整的文本差异\n- max_rounds: 5\n+ max_rounds: 3`}</pre>}
      {change.widens !== undefined && open && (
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
          <p className="m-0 text-sm text-ink-3">
            也可以{' '}
            <a href="#conventions" className="text-ink-2 underline decoration-ink-3 underline-offset-4 hover:text-ink">
              到团队约定里自己改
            </a>
            。
          </p>
        </div>
      )}
      {open && (
        <footer className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" onClick={() => setState('dropped')}>
              不保存
            </Button>
            <Button variant="link" className="px-2" onClick={() => setFull(!full)}>
              {full ? '收起完整差异' : '查看完整差异'}
            </Button>
          </span>
          <span className="flex flex-wrap gap-2">
            <Button variant="outline" aria-expanded={state === 'revising'} onClick={() => setState(state === 'revising' ? 'pending' : 'revising')}>
              修改
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
