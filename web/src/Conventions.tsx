// 团队约定页：在平台上维护工作流（YAML）、约定文档（Markdown）、Agent 模板（YAML）和技能（Markdown）。
// 每次保存是一个新版本，可以看历史和改动。四种约定共用同一套编辑、校验、保存和历史，差异都收在 SPEC 这张表里。
import { useEffect, useMemo, useState } from 'react'
import type { ConventionDetail, ConventionKind, ConventionRow, ConventionsResponse, FieldError } from './api.ts'
import { getConvention, listConventions, saveConvention } from './api.ts'
import { diffLines, diffStat, fold } from './diff.ts'
import { ago } from './format.ts'

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

const NEW_TEMPLATE = `name: my-agent
description: 一句话说明这个 agent 负责什么
model: deepseek-flash
# effort 可选，只能是 low、high、max；不写用模型的默认档位。
effort: high
# write: none 只读；worktree 可以改任务 worktree 里的文件。
write: worktree
# writePaths 限制可以改哪些文件（worktree 内的相对路径或 glob），不写这一行表示整个 worktree 都能改。
# 只读的 agent 不要写 writePaths。
writePaths: [src/**, tests/**, docs/changes.md]
tools:
  # deny 列出不给这个 agent 的工具组：
  # web 联网搜索抓取、subagent 开子 agent、bash 执行命令、schedule 定时任务、todo 待办清单、goal 目标管理。
  deny: [subagent, schedule]
# skills 填平台上已有的技能名（左边「技能」那一栏里的）。
skills: [write-changes]
# mcp 是用 stdio 启动的 MCP 服务，例如 [{ name: docs, command: node, args: [server.mjs] }]；env 里不能放密钥。
mcp: []
prompt: |
  你是……（这个 agent 的身份和职责）
  - 一条一条写清楚要做什么、不要做什么。
  - 每次回复最后简要说明：做了什么、为什么、怎么验证的。
`

const NEW_SKILL = `---
name: my-skill
description: 一句话说明什么时候该用这个技能（agent 靠这句话决定要不要读正文）
---
# 技能名称

写下这个技能要教给 agent 的做法：步骤、格式、例子。
`

/** YAML 顶层的 name:（新建时用来决定保存到哪个名字；真正的校验在服务端）。 */
const yamlName = (source: string) => /^name:\s*(\S+)\s*$/m.exec(source)?.[1] ?? ''
/** 技能的名字只看开头 --- 包住的那一段，正文里的 name: 不算。 */
const frontmatterName = (source: string) => yamlName(/^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '')

type KindSpec = {
  label: string
  /** 侧栏分组标题（复数语气）。 */
  group: string
  starter: string
  rows: number
  /** 新建时名字取自内容；没有这一项的要单独填名字。 */
  nameOf?: (content: string) => string
  /** 新建时显示在编辑器上方的一行说明。 */
  hint?: string
  /** 编辑这一类时始终显示的提醒。 */
  warning?: string
  namePlaceholder?: string
  nameLabel?: string
}

const SPEC: Record<ConventionKind, KindSpec> = {
  workflow: {
    label: '工作流', group: '工作流', starter: NEW_WORKFLOW, rows: 28, nameOf: yamlName,
    hint: '工作流的名字取 YAML 里的 name（小写字母、数字和连字符）。',
  },
  doc: { label: '约定文档', group: '约定文档', starter: NEW_DOC, rows: 22, nameLabel: '文档名', namePlaceholder: '例如：评审约定' },
  template: {
    label: 'Agent 模板', group: 'Agent 模板', starter: NEW_TEMPLATE, rows: 28, nameOf: yamlName,
    hint: '模板的名字取 YAML 里的 name（小写字母、数字和连字符）。工作流里写 role: { template: 名字 } 就能用上。',
    warning: '注意：模板里的 MCP 服务在 agent 沙箱之外运行，拥有平台进程的权限（能读写平台用户能访问的所有文件）。只添加团队信任的服务；env 里不要放密钥。',
  },
  skill: {
    label: '技能', group: '技能', starter: NEW_SKILL, rows: 24, nameOf: frontmatterName,
    hint: '技能的名字取开头 --- 之间的 name（小写字母、数字和连字符）。Agent 模板的 skills 里写上名字就会带给这个 agent。',
  },
}

const KINDS = Object.keys(SPEC) as ConventionKind[]

export const conventionHref = (kind: ConventionKind, name: string) => `#/conventions/${kind}/${encodeURIComponent(name)}`

const KIND_PATTERN = KINDS.join('|')

/** #/conventions、#/conventions/new/<kind>、#/conventions/<kind>/<名字> */
export const parseConventionRoute = (hash: string): { kind?: ConventionKind; name?: string; isNew: boolean } | undefined => {
  if (hash === '#/conventions' || hash === '#/conventions/') return { isNew: false }
  const fresh = new RegExp(`^#/conventions/new/(${KIND_PATTERN})$`).exec(hash)
  if (fresh) return { kind: fresh[1] as ConventionKind, isNew: true }
  const m = new RegExp(`^#/conventions/(${KIND_PATTERN})/(.+)$`).exec(hash)
  if (!m) return undefined
  try {
    return { kind: m[1] as ConventionKind, name: decodeURIComponent(m[2]!), isNew: false }
  } catch {
    return undefined
  }
}

/** 侧栏每一栏的条目：名字、版本，再加一句这一类特有的说明。 */
const entriesOf = (list: ConventionsResponse): Record<ConventionKind, { name: string; version: number; extra?: string }[]> => ({
  workflow: list.workflows.map(w => ({ name: w.name, version: w.version, extra: w.nodes.join(' → ') })),
  doc: list.docs.map(d => ({ name: d.name, version: d.version })),
  template: list.templates.map(t => ({ name: t.name, version: t.version, extra: `${t.write === 'worktree' ? '可写 worktree' : '只读'}${t.description === undefined ? '' : ` · ${t.description}`}` })),
  skill: list.skills.map(k => ({ name: k.name, version: k.version, ...(k.description === undefined ? {} : { extra: k.description }) })),
})

function Sidebar(props: { list: ConventionsResponse | undefined; kind?: ConventionKind; name?: string }) {
  const entries = props.list === undefined ? undefined : entriesOf(props.list)
  return (
    <nav className="conv-side" aria-label="团队约定列表">
      {KINDS.map(kind => (
        <div className="conv-group" key={kind}>
          <div className="conv-group-head"><b>{SPEC[kind].group}</b><a href={`#/conventions/new/${kind}`}>新建</a></div>
          <ul>
            {entries?.[kind].map(e => (
              <li key={e.name}>
                <a href={conventionHref(kind, e.name)} className={props.kind === kind && props.name === e.name ? 'active' : ''}>
                  <span>{e.name}</span>
                  <small className="muted">第 {e.version} 版{e.extra === undefined || e.extra === '' ? '' : ` · ${e.extra}`}</small>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
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

function Editor(props: { kind: ConventionKind; name?: string; isNew: boolean; savedMessage?: string; onSaved: (name: string, message: string) => void }) {
  const spec = SPEC[props.kind]
  const [detail, setDetail] = useState<ConventionDetail>()
  const [loadError, setLoadError] = useState<string>()
  const [name, setName] = useState(props.name ?? '')
  const [content, setContent] = useState(props.isNew ? spec.starter : '')
  const [note, setNote] = useState('')
  const [errors, setErrors] = useState<FieldError[]>([])
  const [checked, setChecked] = useState<'idle' | 'checking' | 'ok' | 'bad'>('idle')
  const [busy, setBusy] = useState(false)
  // 新建保存后会跳到它自己的页面（编辑器重新挂载），保存成功的提示由上层带过来。
  const [message, setMessage] = useState<string | undefined>(props.savedMessage)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    if (props.isNew || props.name === undefined) return
    getConvention(props.kind, props.name).then(d => {
      setDetail(d)
      setContent(d.versions[0]!.content)
      setLoadError(undefined)
    }, e => setLoadError((e as Error).message))
  }, [props.kind, props.name, props.isNew, reload])

  // 新建工作流、模板、技能时名字取自内容（YAML 或开头的 ---）；文档的名字单独填写。
  const target = props.isNew ? (spec.nameOf === undefined ? name.trim() : spec.nameOf(content)) : props.name ?? ''
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
    const saved = `已保存为第 ${r.version} 版。新建的任务会用这一版；进行中的任务不受影响。`
    setMessage(saved)
    if (!props.isNew) setReload(n => n + 1)
    props.onSaved(target, saved)
  }

  if (loadError) return <p className="error">{loadError}</p>
  if (!props.isNew && detail === undefined) return <p className="muted">加载中…</p>
  return (
    <div className="conv-main">
      <div className="conv-title">
        <h1>{props.isNew ? `新建${spec.label}` : props.name}</h1>
        {current && <span className="muted">{spec.label} · 当前第 {current.version} 版 · {ago(current.createdAt)}更新</span>}
      </div>
      {props.isNew && spec.nameOf === undefined && (
        <label className="conv-field">
          <span>{spec.nameLabel ?? '名字'}</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={spec.namePlaceholder} />
        </label>
      )}
      {props.isNew && spec.hint !== undefined && <p className="muted">{spec.hint}</p>}
      {spec.warning !== undefined && <p className="notice warn" role="note">{spec.warning}</p>}
      <textarea
        className="conv-editor mono"
        aria-label={`${spec.label}内容`}
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
        rows={spec.rows}
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
  /** 新建保存后跳到它自己的页面时要继续显示的提示；换到别的约定就清掉。 */
  const [flash, setFlash] = useState<string>()
  useEffect(() => {
    if (flash === undefined) return
    const t = setTimeout(() => setFlash(undefined), 8000)
    return () => clearTimeout(t)
  }, [flash])
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
          <p>团队的工作流、约定文档、Agent 模板和技能放在这里，所有成员发起的任务都按同一份约定执行。</p>
          <ul className="muted">
            <li><b>工作流</b>：从规格到交付的阶段、每个阶段由哪个 agent 做、交付物和验收检查。</li>
            <li><b>约定文档</b>：注入到任务里每个 agent 会话开头的团队规则。工作流用 <code>docs</code> 列出要注入哪些。</li>
            <li><b>Agent 模板</b>：一个 agent 的模型、思考档位、提示词、可写范围、禁用的工具组、技能和 MCP 服务。工作流里写 <code>role: {'{ template: 名字 }'}</code> 复用它。</li>
            <li><b>技能</b>：按需读取的做法说明（dsh 的 <code>SKILL.md</code> 格式）。Agent 模板用 <code>skills</code> 列出带哪些。</li>
            <li>每次保存都是一个新版本。新任务用最新版本，并记录用了哪一版；进行中的任务不受影响。</li>
          </ul>
        </div>
      ) : (
        <Editor
          key={`${kind}/${name ?? ''}/${isNew}`}
          kind={kind}
          {...(name === undefined ? {} : { name })}
          isNew={isNew}
          {...(flash === undefined ? {} : { savedMessage: flash })}
          onSaved={(saved, message) => {
            setReload(n => n + 1)
            if (isNew) {
              setFlash(message)
              location.hash = conventionHref(kind, saved)
            }
          }}
        />
      )}
    </div>
  )
}
