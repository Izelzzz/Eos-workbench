// 代码托管页：用清单流程注册托管平台的 App（现在只有 GitHub App），再用托管平台的账号授权（OAuth），平台以授权人的身份推送、开 PR。
// 注册时浏览器把清单提交到托管平台，用户在那里确认后跳回平台；平台用带回的 code 换 App 的 id 和私钥，存进凭据存储。
import { useEffect, useState } from 'react'
import type { ForgeAppsResponse } from './api.ts'
import { authorizeForgeUser, listForgeApps, registerForgeApp, revokeForgeUser } from './api.ts'
import { ago } from './format.ts'

/** 把字段作为表单 POST 到托管平台：清单要以表单提交，浏览器整页跳过去。 */
const submitForm = (action: string, fields: Record<string, string>) => {
  const form = document.createElement('form')
  form.method = 'post'
  form.action = action
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.append(input)
  }
  document.body.append(form)
  form.submit()
}

export function ForgeApps({ query }: { query: string }) {
  // 回调带回来的结果（registered 或 error）只显示一次：读出来后从地址里去掉，刷新、重新注册时不再显示旧结果。
  const [result, setResult] = useState(() => new URLSearchParams(query))
  useEffect(() => {
    if (query === '') return
    setResult(new URLSearchParams(query))
    history.replaceState(null, '', '#/forges')
  }, [query])
  const [data, setData] = useState<ForgeAppsResponse>()
  const [error, setError] = useState<string>()
  // App 名字在 GitHub 上全局唯一：默认带一段随机字符，减少重名。
  const [appName, setAppName] = useState(() => `eos-${Math.random().toString(36).slice(2, 8)}`)
  const [org, setOrg] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()

  useEffect(() => {
    listForgeApps().then(setData, e => setError(`加载失败：${(e as Error).message}`))
  }, [query])
  // 在托管平台的页面上点了后退：浏览器可能原样恢复这个页面，按钮要能再点。
  useEffect(() => {
    const on = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(false)
    }
    addEventListener('pageshow', on)
    return () => removeEventListener('pageshow', on)
  }, [])

  const register = async (name: string) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    setResult(new URLSearchParams())
    const r = await registerForgeApp({ name, appName, ...(org.trim() === '' ? {} : { org: org.trim() }) })
    if (!r.ok) {
      setBusy(false)
      return setError(r.error)
    }
    submitForm(r.action, r.fields)
  }

  /** 用 GitHub 账号授权：浏览器整页跳到托管平台的授权页，授权完跳回本页。 */
  const authorize = async (name: string) => {
    setBusy(true)
    setError(undefined)
    setNotice(undefined)
    setResult(new URLSearchParams())
    const r = await authorizeForgeUser(name)
    if (!r.ok) {
      setBusy(false)
      return setError(r.error)
    }
    location.assign(r.url)
  }

  /** login：授权人；授权读不出来时没有。 */
  const revoke = async (name: string, login?: string) => {
    const who = login === undefined ? '这条授权' : ` @${login} 的授权`
    if (!confirm(`撤销${who}？之后平台改用 App 自己的身份（或凭据页的 Git 令牌）访问仓库。`)) return
    setError(undefined)
    setResult(new URLSearchParams())
    const r = await revokeForgeUser(name)
    if (!r.ok) return setError(r.error)
    setNotice(r.warning === undefined ? `已撤销${who}` : `已在平台上删掉${who}。${r.warning}`)
    setData(await listForgeApps())
  }

  const registered = result.get('registered')
  const justDone = data?.apps.find(a => a.name === registered)
  return (
    <div className="credentials">
      <h1>代码托管</h1>
      <p className="muted">
        先注册一个 App 并装到要用的仓库，再用 GitHub 账号授权：平台以授权人的身份克隆、推送、开 PR。没人授权时用 App 自己的身份；App 没装到某个仓库时，改用凭据页里的 Git 令牌。App
        的私钥和授权的令牌都加密存在凭据存储里，只由平台使用。
      </p>
      {result.get('error') !== null && (
        <p className="error" role="alert">
          注册没有完成：{result.get('error')}
        </p>
      )}
      {registered !== null && (
        <p className="notice" role="status">
          已注册 App「{result.get('app')}」，凭据存为 <span className="mono">{registered}</span>。下一步：把它安装到要用的仓库
          {justDone?.registered?.installUrl !== undefined && (
            <>
              （
              <a href={justDone.registered.installUrl} target="_blank" rel="noreferrer">
                去安装
              </a>
              ）
            </>
          )}
          。
        </p>
      )}
      {result.get('authorized') !== null && (
        <p className="notice" role="status">
          已用 @{result.get('authorized')} 的 GitHub 账号授权：之后推送和开 PR 都以 @{result.get('authorized')} 的身份进行（仓库要装了 App）。
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data === undefined ? (
        error ? null : (
          <p className="muted">加载中…</p>
        )
      ) : (
        <>
          {!data.usable && (
            <p className="error" role="alert">
              平台没有主密钥，注册后存不了 App 的凭据。{data.hint}
            </p>
          )}
          {data.apps.map(a => (
            <section key={a.name} className="forge-app" aria-label={`${a.host} 的 App`}>
              <h2>GitHub App · {a.host}</h2>
              {a.registered !== undefined ? (
                <>
                  <p>
                    已注册，凭据 <span className="mono">{a.name}</span>，更新于 {ago(a.registered.updatedAt)}。
                  </p>
                  {a.registered.installUrl !== undefined && (
                    <p>
                      <a href={a.registered.installUrl} target="_blank" rel="noreferrer">
                        把 App 安装到仓库
                      </a>
                      ：只勾选要让平台访问的仓库。
                    </p>
                  )}
                  {a.user !== undefined && (
                    <div className="forge-user">
                      <h3>用 GitHub 账号授权</h3>
                      <p className="muted">
                        授权后，平台以授权人的身份推送、开 PR（PR 作者是这个人），只能访问装了 App、而且这个人有权限的仓库。令牌 8 小时过期，平台自动续期。没人授权时用 App 自己的身份。
                      </p>
                      {a.user.authorized !== undefined &&
                        ('login' in a.user.authorized ? (
                          <p>
                            已授权：<b>@{a.user.authorized.login}</b>，更新于 {ago(a.user.authorized.updatedAt)}。{' '}
                            <button type="button" onClick={() => void revoke(a.name, (a.user!.authorized as { login: string }).login)}>
                              撤销授权
                            </button>
                          </p>
                        ) : (
                          <p className="error">
                            授权读不出来：{a.user.authorized.error}{' '}
                            <button type="button" onClick={() => void revoke(a.name)}>
                              撤销授权
                            </button>
                          </p>
                        ))}
                      {a.user.unavailable !== undefined ? (
                        <p className="muted">现在不能授权：{a.user.unavailable}</p>
                      ) : (
                        <div>
                          <button type="button" className={a.user.authorized === undefined ? 'primary' : ''} disabled={busy || !data.usable} onClick={() => void authorize(a.name)}>
                            {busy ? '正在跳转…' : a.user.authorized === undefined ? `用 ${a.host} 账号授权` : '换一个人重新授权'}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  <p className="muted">
                    要换一个 App：先在凭据页删掉 <span className="mono">{a.name}</span>，再回来注册。
                  </p>
                </>
              ) : (
                <form
                  className="new-task"
                  aria-label="注册 App"
                  autoComplete="off"
                  onSubmit={e => {
                    e.preventDefault()
                    void register(a.name)
                  }}
                >
                  <label>
                    <span>App 名字</span>
                    <input value={appName} onChange={e => setAppName(e.target.value)} required spellCheck={false} />
                    <small className="muted">
                      最多 {a.appNameMax} 个字符，在 {a.host} 上全局唯一，到那边还能再改。
                    </small>
                  </label>
                  <label>
                    <span>组织（可选）</span>
                    <input value={org} onChange={e => setOrg(e.target.value)} placeholder="留空时注册在你的个人账号下" spellCheck={false} />
                  </label>
                  <p className="muted">
                    权限：Contents 读写（推任务分支）、Pull requests 读写（开 PR）、Metadata 只读。不用 webhook。 注册完 {a.host} 会跳回 <span className="mono">{data.callbackUrl}</span>
                    ：要用团队成员都能打开的地址访问本页面（部署时设 EOS_PUBLIC_URL）。
                  </p>
                  <div>
                    <button type="submit" className="primary" disabled={busy || !data.usable}>
                      {busy ? '正在跳转…' : `到 ${a.host} 注册`}
                    </button>
                  </div>
                </form>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  )
}
