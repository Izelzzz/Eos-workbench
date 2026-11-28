// 凭据页：平台加密保存的模型 key、Git 令牌。值只写不读：页面和接口都不显示已保存的值，只能替换或删除。
import { useEffect, useState } from 'react'
import type { CredentialKind, CredentialsResponse } from './api.ts'
import { deleteCredential, listCredentials, saveCredential } from './api.ts'
import { ago } from './format.ts'

const KIND: Record<CredentialKind | 'unknown', string> = {
  'api-key': '模型 API key',
  token: 'Git 令牌',
  'github-app': 'GitHub App',
  'github-user': 'GitHub 用户授权',
  unknown: '无法识别（请删掉重新录入）',
}

export function Credentials() {
  const [data, setData] = useState<CredentialsResponse>()
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  /** 用户在下拉框里选的类型；没选过时，名字和已有凭据相同就沿用它的类型，否则是 Git 令牌。 */
  const [kindChoice, setKindChoice] = useState<CredentialKind>()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()

  const load = () =>
    listCredentials().then(
      d => {
        setData(d)
        setError(undefined)
      },
      e => setError(`加载凭据失败：${(e as Error).message}`),
    )
  useEffect(() => {
    void load()
  }, [])

  const existing = data?.items.find(i => i.name === name)?.kind
  // GitHub App 的凭据（id 和私钥）由 GitHub 接入的注册流程写入，这里只能删除，不能用表单覆盖。
  // 用户授权同样只能在代码托管页得到（授权、撤销）。
  const appLocked = existing === 'github-app' || existing === 'github-user'
  const kind: CredentialKind = kindChoice ?? (existing === undefined || existing === 'unknown' || appLocked ? 'token' : existing)

  const save = async () => {
    setBusy(true)
    setNotice(undefined)
    const replacing = data?.items.some(i => i.name === name) ?? false
    const r = await saveCredential({ name, kind, value })
    setBusy(false)
    if (!r.ok) return setError(r.error)
    // 保存后立刻清掉输入框里的值，页面上不留着它。
    setValue('')
    setKindChoice(undefined)
    setError(undefined)
    setNotice(`${replacing ? '已替换' : '已保存'}凭据 ${name}`)
    void load()
  }

  const remove = async (n: string) => {
    const kindOf = data?.items.find(i => i.name === n)?.kind
    // 这里只删平台存的值；GitHub 上的授权还在。授权要在代码托管页撤销（会一并在 GitHub 上撤销）。
    const note =
      kindOf === 'github-user'
        ? '\n\n这只删掉平台存的令牌，GitHub 上的授权还在：要一并撤销，到代码托管页点「撤销授权」。'
        : kindOf === 'github-app'
          ? '\n\n有人用这个 App 授权过时，那条授权也会用不了：先到代码托管页撤销授权。'
          : ''
    if (!confirm(`删除凭据 ${n}？用到它的任务会读不到它。${note}`)) return
    setNotice(undefined)
    const r = await deleteCredential(n)
    if (!r.ok) return setError(r.error)
    setError(undefined)
    setNotice(`已删除凭据 ${n}`)
    void load()
  }

  return (
    <div className="credentials">
      <p className="muted">平台加密保存的模型 API key 和 Git 令牌，只由平台使用，agent 看不到。保存后不再显示值，只能替换或删除。</p>
      {data !== undefined && !data.usable && (
        <p className="error" role="alert">
          平台没有主密钥，不能保存凭据。{data.hint}
        </p>
      )}
      {data?.keyId !== undefined && (
        <p className="muted">
          主密钥指纹 <span className="mono">{data.keyId}</span>
        </p>
      )}
      {data === undefined ? (
        error ? null : (
          <p className="muted">加载中…</p>
        )
      ) : data.items.length === 0 ? (
        <p className="muted">还没有凭据。</p>
      ) : (
        <table className="tasks credential-list">
          <thead>
            <tr>
              <th>名字</th>
              <th>类型</th>
              <th className="fp">主密钥指纹</th>
              <th>更新</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map(i => (
              <tr key={i.name}>
                <td className="mono">{i.name}</td>
                <td>{KIND[i.kind]}</td>
                <td className="mono fp">
                  {data.keyId === undefined || i.keyId === data.keyId ? i.keyId || '—' : <span title="和当前主密钥不同：换回原来的主密钥，或重新录入">{i.keyId || '—'} ⚠</span>}
                </td>
                <td>{i.updatedAt > 0 ? ago(i.updatedAt) : '—'}</td>
                <td>
                  <button type="button" onClick={() => void remove(i.name)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="new-task"
        aria-label="保存凭据"
        autoComplete="off"
        onSubmit={e => {
          e.preventDefault()
          void save()
        }}
      >
        <h2>添加或替换</h2>
        <label>
          <span>名字</span>
          <input value={name} onChange={e => setName(e.target.value.trim())} placeholder="例如 deepseek、github.com" required spellCheck={false} />
          <small className="muted">小写字母、数字和 . _ - :；和已有的名字相同时替换它（类型默认沿用原来的）。</small>
        </label>
        <label>
          <span>类型</span>
          <select value={kind} onChange={e => setKindChoice(e.target.value as CredentialKind)}>
            <option value="token">{KIND.token}</option>
            <option value="api-key">{KIND['api-key']}</option>
          </select>
        </label>
        <label>
          <span>值</span>
          <input type="password" value={value} onChange={e => setValue(e.target.value)} required autoComplete="new-password" spellCheck={false} />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {appLocked && (
          <p className="muted">
            「{name}」是{existing === 'github-user' ? ' GitHub 的用户授权，不能在这里替换；在代码托管页重新授权或撤销' : ' GitHub App 的凭据，不能在这里替换；要换就删掉后重新注册'}。
          </p>
        )}
        <div>
          <button type="submit" className="primary" disabled={busy || data?.usable === false || appLocked}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  )
}
