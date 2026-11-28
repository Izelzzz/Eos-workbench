import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge 默认按 Tailwind 自带的字号名判断冲突；令牌里另加了 code、md 两档字号，
// 不告诉它的话 text-code 会被当成颜色，和 text-muted-foreground 互相覆盖掉
const merge = extendTailwindMerge({
  extend: { theme: { text: ['code', 'md'] } },
})

/** 合并类名：后面的覆盖前面的同类工具类（例如调用方传入的 className 覆盖组件默认的 p-2） */
export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs))
