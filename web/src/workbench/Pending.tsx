import { useEffect, useRef, useState } from 'react'
import { Badge, Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Input, cn } from '../ui/index.ts'
import { ChevronDownIcon } from '../ui/icons.tsx'
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx'
import { KIND_LABEL, type PendingItem } from './mock.ts'
import { Popover } from './Popover.tsx'

type Props = {
  items: PendingItem[]
  /** 这件事处理完了：从队列里拿掉，并更新对应的任务 */
  onResolve: (item: PendingItem) => void
  onOpenTask: (taskId: string, tab: 'process' | 'diff') => void
}

/** 等你处理：一个任务一张卡片，左右滑动；做完的划走。不依赖页面上的其他部分 */
export function Pending({ items, onResolve, onOpenTask }: Props) {
  const track = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  const [leaving, setLeaving] = useState<string>()
  const [entered, setEntered] = useState<string>()
  const [menu, setMenu] = useState(false)
  const current = items[Math.min(index, items.length - 1)]

  const go = (i: number) => {
    const el = track.current?.children[i] as HTMLElement | undefined
    if (el === undefined || track.current === null) return
    track.current.scrollTo({ left: el.offsetLeft, behavior: 'smooth' })
    setIndex(i)
  }

  // 滑动停下后，以最靠左的那张为当前
  const onScroll = () => {
    const t = track.current
    if (t === null) return
    const cards = [...t.children] as HTMLElement[]
    const nearest = cards.reduce((best, c, i) => (Math.abs(c.offsetLeft - t.scrollLeft) < Math.abs(cards[best]!.offsetLeft - t.scrollLeft) ? i : best), 0)
    if (nearest !== index) setIndex(nearest)
  }

  // 鼠标拖拽：按住卡片的空白处左右拖。移动超过几个像素才算拖，不影响点选项
  const drag = useRef<{ x: number; left: number; moved: boolean }>(undefined)
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || (e.target as HTMLElement).closest('button, input, label, a') !== null) return
    drag.current = { x: e.clientX, left: track.current!.scrollLeft, moved: false }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (d === undefined) return
    if (Math.abs(e.clientX - d.x) > 6) d.moved = true
    if (d.moved) track.current!.scrollLeft = d.left - (e.clientX - d.x)
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = undefined
    if (d?.moved) onScrollEndSnap()
  }
  const onScrollEndSnap = () => {
    const t = track.current!
    const cards = [...t.children] as HTMLElement[]
    const nearest = cards.reduce((best, c, i) => (Math.abs(c.offsetLeft - t.scrollLeft) < Math.abs(cards[best]!.offsetLeft - t.scrollLeft) ? i : best), 0)
    go(nearest)
  }

  const resolve = (item: PendingItem) => {
    setLeaving(item.id)
    const next = items[index + 1] ?? items[index - 1]
    setTimeout(() => {
      setLeaving(undefined)
      setEntered(next?.id)
      setIndex(i => Math.min(i, items.length - 2 < 0 ? 0 : items.length - 2))
      onResolve(item)
    }, 240)
  }

  useEffect(() => {
    // 队列变短后，把滚动位置对回当前这张
    const el = track.current?.children[Math.min(index, items.length - 1)] as HTMLElement | undefined
    if (el !== undefined && track.current !== null) track.current.scrollLeft = el.offsetLeft
  }, [items.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section aria-labelledby="wb-pending" className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h1 id="wb-pending" className="m-0 flex items-center gap-2 text-xl font-semibold">
          等你处理
          {items.length > 0 && <Badge variant="warning">{items.length}</Badge>}
        </h1>
        {current !== undefined && items.length > 1 && (
          <Popover
            open={menu}
            onOpenChange={setMenu}
            align="right"
            trigger={
              <Button variant="outline" aria-haspopup="listbox" aria-expanded={menu} onClick={() => setMenu(!menu)} className="max-w-full min-w-0">
                <span className="text-muted-foreground">{KIND_LABEL[current.kind]}</span>
                <span className="min-w-0 truncate">{current.title}</span>
                <span className="text-muted-foreground tabular-nums">
                  {index + 1} / {items.length}
                </span>
                <ChevronDownIcon />
              </Button>
            }
          >
            <ul role="listbox" aria-label="跳到某一件" className="m-0 flex w-80 max-w-full list-none flex-col gap-0.5 p-1">
              {items.map((it, i) => (
                <li key={it.id} role="option" aria-selected={i === index}>
                  <Button
                    variant="ghost"
                    className={cn('h-auto w-full justify-start gap-2 py-2 text-left whitespace-normal', i === index && 'bg-accent')}
                    onClick={() => {
                      setMenu(false)
                      go(i)
                    }}
                  >
                    <Badge variant="outline">{KIND_LABEL[it.kind]}</Badge>
                    <span className="min-w-0 flex-1">{it.title}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </Popover>
        )}
      </div>

      {items.length === 0 ? (
        <p className="m-0 rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground">没有等你处理的事。任务需要你时会出现在这里。</p>
      ) : (
        <div className="group relative min-w-0">
          <div
            ref={track}
            onScroll={onScroll}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            className="wb-track flex min-w-0 snap-x snap-mandatory items-start gap-3 overflow-x-auto"
          >
            {items.map((it, i) => (
              <div
                key={it.id}
                aria-hidden={i !== index}
                className={cn(
                  'min-w-0 shrink-0 snap-start transition-all duration-200',
                  items.length > 1 ? 'w-11/12' : 'w-full',
                  i !== index && 'opacity-60',
                  leaving === it.id && '-translate-x-8 opacity-0',
                  entered === it.id && 'wb-enter',
                )}
              >
                <PendingCard item={it} active={i === index} onActivate={() => go(i)} onResolve={() => resolve(it)} onOpenTask={onOpenTask} />
              </div>
            ))}
            {/* 让最后一张也能滑到最左边 */}
            {items.length > 1 && <div aria-hidden="true" className="w-1/12 shrink-0" />}
          </div>
          {index < items.length - 1 && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-linear-to-l from-background to-transparent" />}
          {index > 0 && (
            <Button variant="outline" size="icon-sm" aria-label="上一件" onClick={() => go(index - 1)} className="absolute top-1/2 -left-4 -translate-y-1/2 rounded-full opacity-0 shadow-md group-hover:opacity-100 focus-visible:opacity-100">
              <ChevronLeftIcon />
            </Button>
          )}
          {index < items.length - 1 && (
            <Button variant="outline" size="icon-sm" aria-label="下一件" onClick={() => go(index + 1)} className="absolute top-1/2 right-1 -translate-y-1/2 rounded-full opacity-0 shadow-md group-hover:opacity-100 focus-visible:opacity-100">
              <ChevronRightIcon />
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

type CardProps = { item: PendingItem; active: boolean; onActivate: () => void; onResolve: () => void; onOpenTask: Props['onOpenTask'] }

function PendingCard({ item, active, onActivate, onResolve, onOpenTask }: CardProps) {
  return (
    <Card
      className={cn('gap-4 py-4', active ? 'border-foreground shadow-md' : 'cursor-pointer')}
      onClick={active ? undefined : onActivate}
      // 没轮到的卡片只是露个边：里面的控件不接受键盘和点击
      inert={!active}
    >
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="warning">{KIND_LABEL[item.kind]}</Badge>
          <CardTitle className="min-w-0 truncate">{item.title}</CardTitle>
        </div>
        <p className="m-0 text-sm text-muted-foreground">{item.meta}</p>
      </CardHeader>
      {item.kind === 'question' && <QuestionBody item={item} onResolve={onResolve} onOpenTask={onOpenTask} />}
      {item.kind === 'accept' && <AcceptBody item={item} onResolve={onResolve} onOpenTask={onOpenTask} />}
      {item.kind === 'proposal' && <ProposalBody item={item} onResolve={onResolve} />}
    </Card>
  )
}

function QuestionBody({ item, onResolve, onOpenTask }: { item: Extract<PendingItem, { kind: 'question' }> } & Pick<CardProps, 'onResolve' | 'onOpenTask'>) {
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<number[]>(item.steps.map(s => s.options.findIndex(o => o.recommended)))
  const [other, setOther] = useState<string[]>(item.steps.map(() => ''))
  const last = item.steps.length
  const answer = (i: number) => (other[i]!.trim() !== '' ? other[i]! : item.steps[i]!.options[picked[i]!]!.label)
  const tabs = [...item.steps.map(s => s.tab), '汇总']
  return (
    <>
      <CardContent className="flex flex-col gap-3">
        <p className="m-0">
          {item.background}{' '}
          <Button variant="link" className="h-auto" onClick={() => onOpenTask(item.taskId, 'process')}>
            看原话
          </Button>
        </p>
        <div role="tablist" aria-label="这件事的几步" className="flex gap-1 border-b border-border">
          {tabs.map((t, i) => (
            <Button
              key={t}
              role="tab"
              aria-selected={i === step}
              variant="ghost"
              onClick={() => setStep(i)}
              className={cn('-mb-px rounded-none border-0 border-b-2 border-transparent px-3 text-muted-foreground', i === step && 'border-primary text-foreground')}
            >
              <span className="tabular-nums">{i + 1}</span> {t}
            </Button>
          ))}
        </div>
        {step < last ? (
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 font-semibold">{item.steps[step]!.question}</legend>
            {item.steps[step]!.options.map((o, i) => {
              const on = picked[step] === i && other[step]!.trim() === ''
              return (
                <label key={o.label} className={cn('flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2', on && 'border-primary bg-accent')}>
                  <input
                    type="radio"
                    name={`${item.id}-${step}`}
                    checked={on}
                    onChange={() => {
                      setPicked(picked.map((p, s) => (s === step ? i : p)))
                      setOther(other.map((v, s) => (s === step ? '' : v)))
                    }}
                    className="mt-1"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {o.label}
                      {o.recommended && <Badge variant="outline">推荐</Badge>}
                    </span>
                    <span className="text-sm text-muted-foreground">{o.note}</span>
                  </span>
                </label>
              )
            })}
            <Input aria-label="其他回答" placeholder="其他" value={other[step]} onChange={e => setOther(other.map((v, s) => (s === step ? e.target.value : v)))} />
          </fieldset>
        ) : (
          <dl className="m-0 flex flex-col gap-2">
            {item.steps.map((s, i) => (
              <div key={s.tab} className="flex gap-4">
                <dt className="w-16 shrink-0 text-muted-foreground">{s.tab}</dt>
                <dd className="m-0 min-w-0 flex-1 wrap-anywhere">{answer(i)}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
      <CardFooter className="justify-end">
        {step > 0 && (
          <Button variant="outline" onClick={() => setStep(step - 1)}>
            回到{tabs[step - 1]}
          </Button>
        )}
        {step < last ? <Button onClick={() => setStep(step + 1)}>{step + 1 < last ? `接着选${tabs[step + 1]}` : '看汇总'}</Button> : <Button onClick={onResolve}>交给规格 agent</Button>}
      </CardFooter>
    </>
  )
}

function AcceptBody({ item, onResolve, onOpenTask }: { item: Extract<PendingItem, { kind: 'accept' }> } & Pick<CardProps, 'onResolve' | 'onOpenTask'>) {
  return (
    <>
      <CardContent className="flex flex-col gap-3">
        <dl className="m-0 flex flex-col gap-1">
          {item.facts.map(([k, v]) => (
            <div key={k} className="flex gap-4">
              <dt className="w-16 shrink-0 text-muted-foreground">{k}</dt>
              <dd className="m-0 min-w-0 flex-1 tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="m-0 border-l-2 border-warning pl-3">
          <span className="text-sm text-muted-foreground">代理人看下来：</span>
          {item.note}
        </p>
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={() => onOpenTask(item.taskId, 'diff')}>
          查看改动
        </Button>
        <span className="flex flex-wrap gap-2">
          <Button variant="outline">打回</Button>
          <Button onClick={onResolve}>通过并开 PR</Button>
        </span>
      </CardFooter>
    </>
  )
}

function ProposalBody({ item, onResolve }: { item: Extract<PendingItem, { kind: 'proposal' }> } & Pick<CardProps, 'onResolve'>) {
  return (
    <>
      <CardContent className="flex flex-col gap-2">
        <p className="m-0">{item.body}</p>
        <p className="m-0 text-sm text-muted-foreground">{item.effect}</p>
      </CardContent>
      <CardFooter className="justify-end">
        <Button variant="outline">拒绝</Button>
        <Button onClick={onResolve}>批准</Button>
      </CardFooter>
    </>
  )
}
