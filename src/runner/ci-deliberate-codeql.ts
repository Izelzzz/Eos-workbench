// CI 故意失败的验证用：把 HTTP 请求参数直接拼进 shell 命令（命令注入），验证 CodeQL 会报。下一个提交撤掉
import { exec } from 'node:child_process'
import { createServer } from 'node:http'

export const ciDeliberate = () =>
  createServer((req, res) => {
    const dir = new URL(req.url ?? '/', 'http://localhost').searchParams.get('dir')
    exec(`ls ${dir}`, (_err, out) => res.end(out))
  })
