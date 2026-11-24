// 任务页的「改动」区：任务分支相对基线已提交的改动，按文件列出；点开一个文件时才去取它的 diff。
import { useEffect, useState } from 'react'
import type { FileChange, FileDiff, TaskChanges } from './api.ts'
import { getChanges, getFileDiff } from './api.ts'

const STATUS_NAME: Record<FileChange['status'], string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '改名' }
/** 没有文本差异时按状态说明原因。 */
const EMPTY: Record<FileChange['status'], string> = { added: '空文件。', deleted: '删除的是空文件。', renamed: '只改了名字，内容没变。', modified: '没有文本差异（例如只改了文件权限）。' }
const RETRY_MS = 3000

const lineClass = (l: string): string => (l.startsWith('@@') ? 'diff-skip' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : 'diff-ctx')

function FileDiffView(props: { id: string; head: string; file: FileChange }) {
  const f = props.file
  const [d, setD] = useState<FileDiff>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (f.binary) return
    // head 变了（任务又有了提交）：清掉上一次的结果和错误再取；失败时每 3 秒重试。
    setD(undefined)
    setError(undefined)
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => getFileDiff(props.id, props.head, f.path).then(
      x => { if (!stopped) { setD(x); setError(undefined) } },
      (e: Error) => { if (!stopped) { setError(e.message); timer = setTimeout(load, RETRY_MS) } },
    )
    void load()
    return () => { stopped = true; clearTimeout(timer) }
  }, [props.id, props.head, f.path, f.binary])
  if (f.binary) return <p className="muted">二进制文件，不显示内容。</p>
  if (error) return <p className="error">{error}（自动重试中）</p>
  if (d === undefined) return <p className="muted">加载中…</p>
  if (d.diff === '') return <p className="muted">{EMPTY[f.status]}</p>
  return (
    <>
      <pre className="diff" aria-label={`${f.path} 的差异`}>
        {d.diff.split('\n').map((l, i) => <div key={i} className={lineClass(l)}>{l === '' ? ' ' : l}</div>)}
      </pre>
      {d.truncated && <p className="muted">{'bytes' in d.truncated ? `差异超过 ${Math.round(d.truncated.bytes / 1024 / 1024)}MB，只显示前面一部分。` : `差异共 ${d.truncated.lines} 行、${d.truncated.chars} 个字符，太长，只显示前面一部分。`}</p>}
    </>
  )
}

/** version 变了就重新加载（平台在开发每次回复后提交，用已完成的调用数作为版本）；加载失败每 3 秒重试。 */
export function Changes(props: { id: string; version: number }) {
  const [data, setData] = useState<TaskChanges>()
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<Set<string>>(new Set())
  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => getChanges(props.id).then(
      d => { if (!stopped) { setData(d); setError(undefined) } },
      (e: Error) => { if (!stopped) { setError(e.message); timer = setTimeout(load, RETRY_MS) } },
    )
    void load()
    return () => { stopped = true; clearTimeout(timer) }
  }, [props.id, props.version])
  const toggle = (path: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const add = data?.files.reduce((n, f) => n + f.add, 0) ?? 0
  const del = data?.files.reduce((n, f) => n + f.del, 0) ?? 0
  return (
    <section className="changes" aria-label="改动">
      <h2>改动</h2>
      {error && <p className="error">{error}（自动重试中）</p>}
      {data === undefined ? (error ? null : <p className="muted">加载中…</p>)
        : data.files.length === 0 ? <p className="muted">还没有提交的改动（相对基线 <span className="mono">{data.base.slice(0, 12)}</span>）。</p>
        : (
          <>
            <p className="muted">
              相对基线 <span className="mono">{data.base.slice(0, 12)}</span>：{data.files.length + data.omitted} 个文件，<span className="diff-add">+{add}</span> <span className="diff-del">-{del}</span>
              {data.omitted > 0 && `（文件太多，只列出前 ${data.files.length} 个，增删行数也只算这些）`}
            </p>
            <ul className="change-files">
              {data.files.map(f => (
                <li key={f.path}>
                  <button className="change-file" aria-expanded={open.has(f.path)} onClick={() => toggle(f.path)}>
                    <span className={`change-status ${f.status}`}>{STATUS_NAME[f.status]}</span>
                    <span className="mono change-path">{f.from === undefined ? f.path : `${f.from} → ${f.path}`}</span>
                    <span className="change-count">{f.binary ? '二进制' : <><span className="diff-add">+{f.add}</span> <span className="diff-del">-{f.del}</span></>}</span>
                  </button>
                  {open.has(f.path) && <FileDiffView id={props.id} head={data.head} file={f} />}
                </li>
              ))}
            </ul>
          </>
        )}
    </section>
  )
}
