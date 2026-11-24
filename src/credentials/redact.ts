// 遮蔽：把文字里出现的已知凭据值换成 ***。用在会被看到或存下来的地方：检查输出、trace、任务日志、服务日志。
// 太短的值不遮蔽：短字符串在普通文字里很常见，替换会误伤；真实的 key 和令牌都远长于这个长度。
import type { Executor } from '../executor/types.ts'
import type { Credentials } from './store.ts'
import { LOCAL_OWNER } from './types.ts'

export const MASK = '***'
export const MIN_SECRET_LENGTH = 8

/**
 * 值嵌在一段更长的字节里、整体做 base64 之后，一定会出现的那段字符（例如 Git 认证头 base64("x-access-token:<令牌>")）。
 * 值在原文里的起点按 3 字节对齐有三种情况，各算一次；每种只取完全由值本身决定的字符，前后跨到别的字节的字符不取，
 * 所以替换后两端最多各留下一个和值有关的字符（不到 2 个字节的信息）。只认标准 base64（+ /），不认 URL 安全的写法（- _）。
 */
export const base64Forms = (s: string): string[] => {
  const bytes = Buffer.from(s, 'utf8')
  return [0, 1, 2].map(offset => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64')
    const first = Math.ceil((offset * 8) / 6)
    const end = Math.floor(((offset + bytes.length) * 8) / 6)
    return encoded.slice(first, end)
  }).filter(f => f.length >= MIN_SECRET_LENGTH)
}

/** 一个值可能出现的写法：原样、JSON 转义后的样子（多行的私钥在 trace 的 JSON 字符串里换行是 \n），以及 base64 编码在更长内容里的样子。 */
const forms = (s: string): string[] => {
  const escaped = JSON.stringify(s).slice(1, -1)
  return [...new Set([s, escaped, ...base64Forms(s)])]
}

/** 把 text 里的每个 secret 换成 ***。长的先换：一个值包含另一个值时，不会只换掉一部分。 */
export const redactText = (text: string, secrets: readonly string[]): string =>
  secrets.filter(s => s.length >= MIN_SECRET_LENGTH).flatMap(forms).sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join(MASK), text)

/** 遮蔽一个 JSON 形状的值里所有的字符串（trace 事件、检查结果），其余原样保留。 */
export const redactDeep = <T>(value: T, redact: (s: string) => string): T => {
  if (typeof value === 'string') return redact(value) as T
  if (Array.isArray(value)) return value.map(v => redactDeep(v, redact)) as T
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T
  return value
}

/** 执行器抛出的错误（例如 dsh 的报错）也会进日志和失败原因：消息和堆栈一起遮蔽。 */
const redactError = (e: unknown, redact: (s: string) => string): unknown => {
  if (e instanceof Error) {
    e.message = redact(e.message)
    if (e.stack !== undefined) e.stack = redact(e.stack)
  }
  return e
}

/**
 * 包一层执行器：回复、实时 trace 事件、回放的 trace、agent 的提问都先遮蔽再交出去。
 * 平台拿到的 agent 输出都经过这里，存进任务、显示在页面和日志里的就都是遮蔽过的。
 */
export const redacting = (ex: Executor, redact: (s: string) => string): Executor => ({
  send: async p => {
    const reply = await ex.send({
      ...p,
      ask: (q, signal) => p.ask(redactDeep(q, redact), signal),
      ...(p.onEvent === undefined ? {} : { onEvent: e => p.onEvent!(redactDeep(e, redact)) }),
    }).catch(e => { throw redactError(e, redact) })
    return { ...reply, text: redact(reply.text) }
  },
  findReply: async (key, nonce) => {
    const r = await ex.findReply(key, nonce)
    return r === undefined ? undefined : { ...r, text: redact(r.text) }
  },
  traceOf: async (key, nonce) => redactDeep(await ex.traceOf(key, nonce), redact),
  release: cwd => ex.release(cwd),
  close: () => ex.close(),
})

/**
 * 当前已知的凭据值：凭据存储里能解密的全部，加上 extra（例如来自环境变量的模型 key、主密钥）。
 * 每条 trace 事件的每个字符串都要遮蔽，所以最多每秒查一次凭据列表；列表的名字或更新时间变了才重新解密。
 * 在 Web 上增删改凭据之后，最迟一秒后生效。
 */
export const knownSecrets = (credentials: Credentials, extra: readonly string[], now: () => number = Date.now, onError: (e: unknown) => void = () => {}): (() => readonly string[]) => {
  let cache: { sig: string; values: string[] } | undefined
  let checkedAt = -Infinity
  let reported = false
  return () => {
    if (cache !== undefined && now() - checkedAt < 1000) return [...cache.values, ...extra]
    checkedAt = now()
    let items
    try {
      items = credentials.list(LOCAL_OWNER)
    } catch (e) {
      // 读不了凭据列表（例如数据库损坏）：沿用上次的值，遮蔽不能让写日志的地方出错；报一次错，不悄悄降级。
      if (!reported) onError(e)
      reported = true
      return [...(cache?.values ?? []), ...extra]
    }
    const sig = items.map(i => `${i.name}@${i.updatedAt}`).join('\n')
    if (cache?.sig !== sig) cache = { sig, values: items.flatMap(i => { const r = credentials.get(LOCAL_OWNER, i.name); return r.kind === 'ok' ? [r.value] : [] }) }
    return [...cache.values, ...extra]
  }
}
