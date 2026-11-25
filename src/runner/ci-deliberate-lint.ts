// CI 故意失败的验证用：违反「执行器只在 src/executor/ 里接入」。下一个提交撤掉
import { DshExecutor } from '../executor/dsh.ts'
import * as dsh from '@deepseek-ai/dsh-session'
export const ciDeliberate = [DshExecutor, dsh]
