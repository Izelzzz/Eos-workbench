// 日志文件：数据目录下的 logs/。每个任务一个 <任务>.log（进度行和错误详情），Web 服务进程一个 eos.log。
// 写日志失败不影响任务：日志只是观测数据。
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const logsDir = (dataDir: string): string => join(dataDir, 'logs')
export const taskLogPath = (dataDir: string, id: string): string => join(logsDir(dataDir), `${id}.log`)
export const processLogPath = (dataDir: string): string => join(logsDir(dataDir), 'eos.log')

/** 每行前面加上 ISO 时间；多行的内容每行都带时间。 */
export const appendLog = (path: string, text: string, at: number = Date.now()): void => {
  const stamp = new Date(at).toISOString()
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    appendFileSync(
      path,
      text
        .split('\n')
        .map(l => `${stamp} ${l}\n`)
        .join(''),
    )
  } catch {
    // 磁盘满、没有权限：不打断任务。
  }
}
