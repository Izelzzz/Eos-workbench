// CI 故意失败的验证用：违反「纯逻辑不读写文件、不读时钟」。下一个提交撤掉
import { readFileSync } from 'node:fs'
export const ciDeliberate = () => [readFileSync, Date.now()]
