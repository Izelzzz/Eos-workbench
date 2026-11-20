// 团队约定页：在平台上维护工作流（YAML）和约定文档（Markdown）。每次保存是一个新版本，可以看历史和改动。
import { useEffect, useMemo, useState } from 'react'
import type { ConventionDetail, ConventionKind, ConventionRow, ConventionsResponse, FieldError } from './api.ts'
import { getConvention, listConventions, saveConvention } from './api.ts'
import { diffLines, diffStat, fold } from './diff.ts'
import { ago } from './format.ts'

const KIND_LABEL: Record<ConventionKind, string> = { workflow: '工作流', doc: '约定文档' }

const NEW_WORKFLOW = `name: my-flow
description: 一句话说明这个工作流做什么
docs: []
roles:
  developer:
    write: worktree
    prompt: 你是严谨的软件工程师……
nodes:
  - id: build
    kind: agent
    role: developer
    task: 按需求实现。
    deliverables:
      - { path: docs/changes.md, sections: [改动, 验证] }
`

const NEW_DOC = `# 约定名称

写下团队所有 agent 都要遵守的规则。
`

export const conventionHref = (kind: ConventionKind, name: string) => `#/conventions/${kind}/${encodeURIComponent(name)}`

/** #/conventions、#/conventions/new/<kind>、#/conventions/<kind>/<名字> */
export const parseConventionRoute = (hash: string): { kind?: ConventionKind; name?: string; isNew: boolean } | undefined => {
  if (hash === '#/conventions' || hash === '#/conventions/') return { isNew: false }
  const fresh = /^#\/conventions\/new\/(workflow|doc)$/.exec(hash)
  if (fresh) return { kind: fresh[1] as ConventionKind, isNew: true }
  const m = /^#\/conventions\/(workflow|doc)\/(.+)$/.exec(hash)
  if (!m) return undefined
  try {
    return { kind: m[1] as ConventionKind, name: decodeURIComponent(m[2]!), isNew: false }
  } catch {
    return undefined
  }
}

function Sidebar(props: { list: ConventionsResponse | undefined; kind?: ConventionKind; name?: string }) {
  const item = (kind: ConventionKind, name: string, version: number, extra?: string) => (
    <li key={`${kind}/${name}`}>
      <a href={conventionHref(kind, name)} className={props.kind === kind && props.name === name ? 'active' : ''}>
        <span>{name}</span>
        <small className="muted">第 {version} 版{extra === undefined ? '' : ` · ${extra}`}</small>
      </a>
    </li>
  )
  return (
    <nav className="conv-side" aria-label="团队约定列表">
      <div className="conv-group">
        <div className="conv-group-head"><b>工作流</b><a href="#/conventions/new/workflow">新建</a></div>
        <ul>{props.list?.workflows.map(w => item('workflow', w.name, w.version, w.nodes.join(' → ')))}</ul>
      </div>
      <div className="conv-group">
        <div className="conv-group-head"><b>约定文档</b><a href="#/conventions/new/doc">新建</a></div>
        <ul>{props.list?.docs.map(d => item('doc', d.name, d.version))}</ul>
      </div>
    </nav>
  )
}

function Diff(props: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(props.before, props.after), [props.before, props.after])
  const stat = diffStat(lines)
  if (stat.add === 0 && stat.del === 0) return <p className="muted">没有改动</p>
  return (
    <>
      <p className="muted"><span className="diff-add">+{stat.add}</span> <span className="diff-del">-{stat.del}</span></p>
      <pre className="diff" aria-label="改动">
        {fold(lines).map((l, i) => l.kind === 'skip'
          ? <div key={i} className="diff-skip">⋯ 省略 {l.count} 行未改动</div>
          : <div key={i} className={`diff-${l.kind}`}>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}{l.text}</div>)}
      </pre>
    </>
  )
}

function History(props: { detail: ConventionDetail; onRestore: (content: string) => void }) {
  const [shown, setShown] = useState<number>(props.detail.versions[0]!.version)
  const index = props.detail.versions.findIndex(v => v.version === shown)
  const version = props.detail.versions[index]
  const previous = props.detail.versions[index + 1]
  return (
    <section className="conv-history" aria-label="历史版本">
      <h2>历史版本</h2>
      <ol>
        {props.detail.versions.map(v => (
          <li key={v.version}>
            <button className={v.version === shown ? 'link active' : 'link'} onClick={() => setShown(v.version)}>
              第 {v.version} 版
            </button>
            <span className="muted"> · {ago(v.createdAt)} · {v.actor === 'platform' ? '平台' : v.actor}{v.note === '' ? '' : ` · ${v.note}`}</span>
          </li>
        ))}
      </ol>
      {version && (
        <div className="conv-version">
          <div className="conv-version-head">
            <b>第 {version.version} 版{previous ? `相对第 ${previous.version} 版的改动` : '（第一版）'}</b>
            {index > 0 && <button onClick={() => props.onRestore(version.content)}>把这一版放回编辑器</button>}
          </div>
          <Diff before={previous?.content ?? ''} after={version.content} />
        </div>
      )}
    </section>
  )
}

function Editor(props: { kind: ConventionKind; name?: string; isNew: boolean; onSaved: (name: string) => void }) {
  const [detail, setDetail] = useState<ConventionDetail>()
  const [loadError, setLoadError] = useState<string>()
  const [name, setName] = useState(props.name ?? '')
  const [content, setContent] = useState(props.isNew ? (props.kind === 'workflow' ? NEW_WORKFLOW : NEW_DOC) : '')
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<FieldError[]>([])
  const [checked, setChecked] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (props.isNew || props.name === undefined) return
    getConvention(props.kind, props.name).then(d => {
      setDetail(d)
      setContent(d.versions[0]!.content)
      setLoadError(undefined)
    }, e => setLoadError((e as Error).message))
  }, [props.kind, props.name, props.isNew, reload])

  // 新建工作流时名字取自 YAML 里的 name；文档的名字单独填写。
  const yamlName = props.kind === 'workflow' ? /^name:\s*(\S+)\s*$/m.exec(content)?.[1] ?? '' : ''
  const target = props.isNew ? (props.kind === 'workflow' ? yamlName : name.trim()) : props.name ?? ''
  const current: ConventionRow | undefined = detail?.versions[0]
  const dirty = props.isNew || current === undefined || content !== current.content

  // 边写边校验：停止输入半秒后发给服务端检查（不保存）。
  useEffect(() => {
    if (target === '' || !dirty) {
      setErrors([])
      setChecked('idle')
      return
    }
    setChecked('checking')
    const t = setTimeout(() => {
      void saveConvention(props.kind, target, { content, validateOnly: true }).then(r => {
        if (r.ok) {
          setErrors([])
          setChecked('ok')
        } else {
          setErrors('errors' in r ? r.errors : [{ path: '(请求)', message: r.error }])
          setChecked('bad')
        }
      })
    }, 500)
    return () => clearTimeout(t)
  }, [content, target, dirty, props.kind])

  const save = async () => {
    setBusy(true)
    setMessage(undefined)
    const r = await saveConvention(props.kind, target, { content, note })
    setBusy(false)
    if (!r.ok) {
      setErrors('errors' in r ? r.errors : [{ path: '(请求)', message: r.error }])
      setChecked('bad')
      return
    }
    setNote('')
    setMessage(`已保存为第 ${r.version} 版。新建的任务会用这一版；进行中的任务不受影响。`)
    if (!props.isNew) setReload(n => n + 1)
    props.onSaved(target)
  }

  if (loadError) return <p className="error">{loadError}</p>
  if (!props.isNew && detail === undefined) return <p className="muted">加载中…</p>
  return (
    <div className="conv-main">
      <div className="conv-title">
        <h1>{props.isNew ? `新建${KIND_LABEL[props.kind]}` : props.name}</h1>
        {current && <span className="muted">{KIND_LABEL[props.kind]} · 当前第 {current.version} 版 · {ago(current.createdAt)}更新</span>}
      </div>
      {props.isNew && props.kind === 'doc' && (
        <label className="conv-field">
          <span>文档名</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：评审约定" />
        </label>
      )}
      {props.isNew && props.kind === 'workflow' && <p className="muted">工作流的名字取 YAML 里的 <code>name</code>（小写字母、数字和连字符）。</p>}
      <textarea
        className="conv-editor mono"
        aria-label={`${KIND_LABEL[props.kind]}内容`}
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
        rows={props.kind === 'workflow' ? 28 : 22}
      />
      <div className="conv-check" aria-live="polite">
        {checked === 'checking' && <span className="muted">检查中…</span>}
        {checked === 'ok' && <span className="ok-text">格式正确，可以保存</span>}
        {errors.length > 0 && (
          <ul className="conv-errors" role="alert" aria-label="错误">
            {errors.map((e, i) => <li key={i}><code>{e.path}</code>：{e.message}</li>)}
          </ul>
        )}
      </div>
      <div className="conv-save">
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="这次修改的说明（可选），例如：评审前先跑测试" aria-label="修改说明" />
        <button className="primary" disabled={busy || !dirty || target === '' || checked === 'bad' || checked === 'checking'} onClick={() => void save()}>
          {busy ? '保存中…' : '保存为新版本'}
        </button>
      </div>
      {message && <p className="notice" role="status">{message}</p>}
      {!props.isNew && current && dirty && (
        <details className="conv-pending" open>
          <summary>未保存的改动（相对第 {current.version} 版）</summary>
          <Diff before={current.content} after={content} />
        </details>
      )}
      {detail && <History key={`${detail.versions[0]!.version}`} detail={detail} onRestore={setContent} />}
    </div>
  )
}

export function Conventions(props: { route: { kind?: ConventionKind; name?: string; isNew: boolean } }) {
  const [list, setList] = useState<ConventionsResponse>()
  const [error, setError] = useState<string>()
  const [reload, setReload] = useState(0)
  useEffect(() => {
    listConventions().then(l => { setList(l); setError(undefined) }, e => setError((e as Error).message))
  }, [reload])
  const { kind, name, isNew } = props.route
  return (
    <div className="conventions">
      <Sidebar list={list} {...(kind === undefined ? {} : { kind })} {...(name === undefined ? {} : { name })} />
      {error && <p className="error">{error}</p>}
      {kind === undefined ? (
        <div className="conv-main">
          <h1>团队约定</h1>
          <p>团队的工作流和约定文档放在这里，所有成员发起的任务都按同一份约定执行。</p>
          <ul className="muted">
            <li><b>工作流</b>：从规格到交付的阶段、每个阶段由哪个 agent 做、交付物和验收检查。</li>
            <li><b>约定文档</b>：注入到任务里每个 agent 会话开头的团队规则。工作流用 <code>docs</code> 列出要注入哪些。</li>
            <li>每次保存都是一个新版本。新任务用最新版本，并记录用了哪一版；进行中的任务不受影响。</li>
          </ul>
        </div>
      ) : (
        <Editor
          key={`${kind}/${name ?? ''}/${isNew}`}
          kind={kind}
          {...(name === undefined ? {} : { name })}
          isNew={isNew}
          onSaved={saved => {
            setReload(n => n + 1)
            if (isNew) location.hash = conventionHref(kind, saved)
          }}
        />
      )}
    </div>
  )
}
