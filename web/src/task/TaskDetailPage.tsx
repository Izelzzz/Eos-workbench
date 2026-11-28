import { useState } from 'react'
import { AccentDot, Badge, Button, Card, CardDescription, CardFooter, CardHeader, CardTitle, InfoList, InfoRow, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Segmented, SegmentedItem, SegmentedList, SegmentedPanel, cn } from '../ui/index.ts'
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from '../ui/icons.tsx'
import { ArrowLeftIcon, MoreIcon } from '../chats/icons.tsx'
import { fmt, fmtTok, stages, task, type Call, type Span, type Stage } from './mock.ts'

/** 任务详情页：一个任务完整的过程记录。从任务列表进来，需要时才看 */
export function TaskDetailPage() {
  const [stage, setStage] = useState(stages.findIndex(s => s.name === '测试'))
  const [open, setOpen] = useState<string[]>(['t2'])
  const [span, setSpan] = useState<Span>()
  const current = stages[stage]!
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-8 px-4 py-5 md:overflow-y-auto md:px-10 md:py-8">
        <Header />
        <Card>
          <CardHeader>
            <span className="flex items-center gap-2 text-sm font-medium text-accent">
              <AccentDot />
              等你{task.waiting.kind}
            </span>
            <CardTitle>{task.waiting.line}</CardTitle>
            <CardDescription>6 个文件，+174 −18。测试和评审都通过了。筛选条件没有保存到地址里，刷新后会丢；规格没有要求。</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button variant="outline">打回</Button>
            <Button>通过并开 PR</Button>
          </CardFooter>
        </Card>

        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="m-0 text-sm font-medium text-ink-2">阶段</h2>
          <StageStrip
            current={stage}
            onPick={i => {
              setStage(i)
              setSpan(undefined)
            }}
          />
        </section>

        <Segmented defaultValue="process">
          <SegmentedList>
            <SegmentedItem value="process">过程</SegmentedItem>
            <SegmentedItem value="changes">改动</SegmentedItem>
            <SegmentedItem value="outputs">产出</SegmentedItem>
            <SegmentedItem value="usage">用量</SegmentedItem>
          </SegmentedList>
          <SegmentedPanel value="process">
            <Process stage={current} open={open} onToggle={id => setOpen(open.includes(id) ? open.filter(x => x !== id) : [...open, id])} picked={span} onPick={setSpan} />
          </SegmentedPanel>
          <SegmentedPanel value="changes">
            <ul className="m-0 flex list-none flex-col p-0">
              {task.files.map(([f, c]) => (
                <li key={f} className="flex items-baseline justify-between gap-4 border-t border-line py-2.5 last:border-b">
                  <code className="min-w-0 font-mono text-code wrap-anywhere">{f}</code>
                  <span className="flex-none text-sm text-ink-3 tabular-nums">{c}</span>
                </li>
              ))}
            </ul>
          </SegmentedPanel>
          <SegmentedPanel value="outputs">
            <ul className="m-0 flex list-none flex-col p-0">
              {task.outputs.map(([f, d]) => (
                <li key={f} className="flex flex-wrap items-baseline justify-between gap-x-4 border-t border-line py-2.5 last:border-b">
                  <code className="font-mono text-code">{f}</code>
                  <span className="text-sm text-ink-3">{d}</span>
                </li>
              ))}
            </ul>
          </SegmentedPanel>
          <SegmentedPanel value="usage">
            <Usage />
          </SegmentedPanel>
        </Segmented>
      </div>

      <aside className="flex w-full flex-none flex-col gap-7 border-t border-line px-4 py-5 md:w-sm md:overflow-y-auto md:border-t-0 md:border-l md:px-7 md:py-8">
        {span !== undefined ? <SpanDetail span={span} onClose={() => setSpan(undefined)} /> : <Facts />}
      </aside>
    </main>
  )
}

function Header() {
  return (
    <header className="flex min-w-0 flex-col gap-2">
      <Button variant="ghost" size="sm" className="-ml-2.5 self-start">
        <ArrowLeftIcon />
        任务
      </Button>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <h1 className="m-0 min-w-0 text-title leading-tight font-semibold tracking-title">{task.title}</h1>
        <Menu>
          <MenuTrigger render={<Button variant="outline" size="icon" aria-label="更多操作" />}>
            <MoreIcon />
          </MenuTrigger>
          <MenuContent>
            <MenuItem>下载完整日志</MenuItem>
            <MenuItem>提交一条修正</MenuItem>
            <MenuSeparator />
            <MenuItem className="text-destructive">中止任务</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      <p className="m-0 text-sm text-ink-3">
        {task.id} · eos-workbench · 开始于今天 13:02 · 已用 34 分钟
      </p>
    </header>
  )
}

const STATE_TEXT = { passed: '通过', running: '进行中', waiting: '等你', todo: '还没开始', failed: '失败' } as const

/** 阶段条：一行连起来的阶段，放不下时横向滚动。点一个阶段看它的过程 */
function StageStrip({ current, onPick }: { current: number; onPick: (i: number) => void }) {
  return (
    <ol className="task-strip m-0 flex list-none items-stretch gap-0 overflow-x-auto p-0 pb-1">
      {stages.map((s, i) => (
        <li key={s.name} className="flex flex-none items-center">
          {i > 0 && <span aria-hidden="true" className="h-px w-4 flex-none bg-line" />}
          <Button
            variant="ghost"
            aria-pressed={i === current}
            onClick={() => onPick(i)}
            className={cn('h-auto min-w-28 flex-col items-start gap-0.5 rounded-control border border-line px-3 py-2 text-left font-normal', i === current && 'border-ink bg-surface shadow-selected hover:bg-surface')}
          >
            <span className="flex items-center gap-1.5 font-medium text-ink">
              {s.state === 'passed' && <CheckIcon width={13} height={13} className="text-ink-3" />}
              {s.state === 'waiting' && <AccentDot />}
              {s.name}
            </span>
            <span className={cn('text-xs text-ink-3', s.state === 'waiting' && 'text-accent')}>{s.note}</span>
          </Button>
        </li>
      ))}
    </ol>
  )
}

type ProcessProps = { stage: Stage; open: string[]; onToggle: (id: string) => void; picked: Span | undefined; onPick: (s: Span) => void }

/** 一个阶段的过程：按轮次，每轮里是一次次调用；点开一次调用看它里面的每一步 */
function Process({ stage, open, onToggle, picked, onPick }: ProcessProps) {
  if (stage.rounds.length === 0) return <p className="m-0 rounded-card border border-dashed border-line px-5 py-9 text-center text-ink-3">这个阶段还没有开始。你验收通过后，平台推送分支并开 PR。</p>
  return (
    <div className="flex flex-col gap-6">
      {stage.rounds.map(r => (
        <section key={r.n} className="flex flex-col">
          <h3 className="m-0 mb-1 flex items-baseline gap-2 text-sm font-medium text-ink-2">
            第 {r.n} 轮<span className="font-normal text-ink-3">{r.result}</span>
          </h3>
          <ul className="m-0 flex list-none flex-col p-0">
            {r.calls.map(c => (
              <CallRow key={c.id} call={c} open={open.includes(c.id)} onToggle={() => onToggle(c.id)} picked={picked} onPick={onPick} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function CallRow({ call, open, onToggle, picked, onPick }: { call: Call; open: boolean; onToggle: () => void; picked: Span | undefined; onPick: (s: Span) => void }) {
  const longest = Math.max(...call.spans.map(s => s.ms), 1)
  return (
    <li className="border-t border-line last:border-b">
      <Button variant="ghost" aria-expanded={open} onClick={onToggle} className="h-auto w-full items-baseline justify-start gap-3 rounded-control px-0 py-2.5 text-left font-normal hover:bg-transparent aria-expanded:bg-transparent">
        <ChevronRightIcon width={14} height={14} className={cn('flex-none self-center text-ink-3 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="w-20 flex-none text-ink-3">{call.who}</span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ink">
          {call.ok === false && <XIcon width={13} height={13} className="flex-none text-destructive" />}
          <span className="min-w-0 truncate">{call.what}</span>
        </span>
        <span className="flex-none text-sm text-ink-3 tabular-nums">
          {fmt(call.ms)}
          {call.tokens !== undefined && ` · ${fmtTok(call.tokens)}`}
        </span>
      </Button>
      {open && (
        <ul className="task-enter m-0 mb-3 ml-6 flex list-none flex-col gap-0.5 p-0">
          {call.spans.map((s, i) => (
            <li key={i}>
              <Button
                variant="ghost"
                aria-pressed={picked === s}
                onClick={() => onPick(s)}
                className={cn('h-8 w-full justify-start gap-3 rounded-lg px-2 text-left text-sm font-normal', picked === s && 'bg-fill text-ink')}
              >
                <span className="w-9 flex-none text-ink-3">{s.kind}</span>
                <span className="min-w-0 flex-1 truncate text-ink">{s.title}</span>
                <span aria-hidden="true" className="hidden w-24 flex-none sm:flex">
                  <span className="h-1 rounded-full bg-ink-3" style={{ width: `${Math.max(4, (s.ms / longest) * 100)}%` }} />
                </span>
                <span className="w-16 flex-none text-right text-ink-3 tabular-nums">{s.ms === 0 ? '' : fmt(s.ms)}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** 右栏：没有选中某一步时，是这个任务的基本信息 */
function Facts() {
  return (
    <>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-sm font-medium text-ink-2">需求</h2>
        <p className="m-0 wrap-anywhere">{task.need}</p>
      </section>
      <InfoList>
        {task.facts.map(([k, v]) => (
          <InfoRow key={k} label={k}>
            {v}
          </InfoRow>
        ))}
      </InfoList>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-sm font-medium text-ink-2">你做过的决定</h2>
        {task.decisions.map(d => (
          <div key={d.q} className="flex flex-col">
            <span className="text-xs text-ink-3">{d.when}</span>
            <span className="text-ink-2">{d.q}</span>
            <span className="font-medium">{d.a}</span>
          </div>
        ))}
      </section>
    </>
  )
}

/** 右栏：选中过程里的一步时，是这一步的输入、思考、输出 */
function SpanDetail({ span, onClose }: { span: Span; onClose: () => void }) {
  const block = (label: string, text: string | undefined) =>
    text !== undefined && (
      <section className="flex flex-col gap-1.5">
        <h3 className="m-0 text-sm font-medium text-ink-2">{label}</h3>
        <pre className="m-0 overflow-x-auto rounded-box bg-fill p-3 font-mono text-code whitespace-pre-wrap text-ink wrap-anywhere">{text}</pre>
      </section>
    )
  return (
    <div className="task-enter flex flex-col gap-5">
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Badge variant="neutral">{span.kind}</Badge>
          <h2 className="m-0 text-md font-semibold wrap-anywhere">{span.title}</h2>
          <span className="text-sm text-ink-3 tabular-nums">
            {span.ms === 0 ? '' : fmt(span.ms)}
            {span.tokens !== undefined && ` · ${fmtTok(span.tokens)} token`}
          </span>
        </div>
        <Button variant="ghost" size="icon" aria-label="关闭这一步的详情" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      {block('输入', span.input)}
      {block('思考', span.thinking)}
      {block('输出', span.output)}
    </div>
  )
}

/** 用量：每个阶段花了多少时间和 token，横条按最长的那个等比例画 */
function Usage() {
  const rows = stages.map(s => {
    const calls = s.rounds.flatMap(r => r.calls)
    return { name: s.name, ms: calls.reduce((a, c) => a + c.ms, 0), tokens: calls.reduce((a, c) => a + (c.tokens ?? 0), 0), rounds: s.rounds.length }
  })
  const longest = Math.max(...rows.map(r => r.ms), 1)
  const total = rows.reduce((a, r) => ({ ms: a.ms + r.ms, tokens: a.tokens + r.tokens }), { ms: 0, tokens: 0 })
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-ink-2">
        一共 <span className="font-medium text-ink tabular-nums">{fmt(total.ms)}</span>，<span className="font-medium text-ink tabular-nums">{fmtTok(total.tokens)}</span> token。
      </p>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map(r => (
          <li key={r.name} className="flex items-center gap-4 border-t border-line py-2.5 last:border-b">
            <span className="w-12 flex-none font-medium">{r.name}</span>
            <span aria-hidden="true" className="flex min-w-0 flex-1">
              <span className="h-1.5 rounded-full bg-ink" style={{ width: `${(r.ms / longest) * 100}%` }} />
            </span>
            <span className="w-40 flex-none text-right text-sm text-ink-3 tabular-nums">{r.ms === 0 ? '—' : `${fmt(r.ms)} · ${fmtTok(r.tokens)} · ${r.rounds} 轮`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
