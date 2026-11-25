// 右侧详情：选中 span 的元数据、输入、思考、输出。长文本默认折叠。
import { Fragment, useState } from 'react'
import type { Span } from './api.ts'
import { clock, duration, KIND, STATUS, statusClass, tokens } from './format.ts'

function Block(props: { title: string; text: string | undefined }) {
  const [full, setFull] = useState(false)
  if (props.text === undefined || props.text.trim() === '') return null
  const long = props.text.length > 4000
  return (
    <section className="block">
      <header>
        <h3>{props.title}</h3>
        <span className="muted">{props.text.length.toLocaleString()} 字</span>
        <button onClick={() => void navigator.clipboard?.writeText(props.text!)}>复制</button>
      </header>
      <pre>{long && !full ? `${props.text.slice(0, 4000)}…` : props.text}</pre>
      {long && (
        <button className="more" onClick={() => setFull(!full)}>
          {full ? '收起' : '显示全部'}
        </button>
      )}
    </section>
  )
}

export function Detail(props: { span: Span | undefined; now: number }) {
  const s = props.span
  if (s === undefined) return <aside className="detail empty">在左侧选择一行查看详情</aside>
  const u = s.usage
  const inputTitle = s.kind === 'tool' ? '参数' : s.kind === 'model' ? '输入（提示词或上一步的工具结果）' : '输入'
  const outputTitle = s.kind === 'tool' ? '结果' : s.kind === 'question' ? '问题' : s.kind === 'answer' ? '回答' : '输出'
  return (
    <aside className="detail">
      <div className="detail-title">
        <span className={`badge kind-${s.kind}`}>{KIND[s.kind]}</span>
        <h2>{s.name}</h2>
        <span className={`pill ${statusClass(s.status)}`}>{STATUS[s.status] ?? s.status}</span>
      </div>
      <dl className="facts">
        {s.start > 0 && (
          <>
            <dt>开始</dt>
            <dd>{clock(s.start)}</dd>
          </>
        )}
        {s.start > 0 && (
          <>
            <dt>耗时</dt>
            <dd>
              {duration((s.end ?? props.now) - s.start)}
              {s.end === undefined ? '（进行中）' : ''}
            </dd>
          </>
        )}
        {s.model && (
          <>
            <dt>模型</dt>
            <dd>{s.model}</dd>
          </>
        )}
        {u && (
          <>
            <dt>tokens</dt>
            <dd>
              输入 {tokens(u.input)} · 输出 {tokens(u.output)} · 缓存读 {tokens(u.cacheRead)} · 缓存写 {tokens(u.cacheWrite)}
            </dd>
          </>
        )}
        {Object.entries(s.meta).map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
      <Block title={inputTitle} text={s.input} />
      <Block title="思考过程" text={s.reasoning} />
      <Block title={outputTitle} text={s.output} />
    </aside>
  )
}
