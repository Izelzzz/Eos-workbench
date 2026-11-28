import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge 按 Tailwind 自带的档位名判断两个类是否冲突。令牌里另起了名字的字号、圆角、阴影要告诉它，
// 不然 text-lead 会被当成颜色，和 text-ink-2 互相覆盖掉
const merge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['code', 'md', 'control', 'lead', 'pane', 'title'],
      radius: ['control', 'box', 'chat', 'input', 'card'],
      shadow: ['card', 'popover', 'segment', 'selected'],
    },
  },
})

/** 合并类名：后面的覆盖前面的同类工具类（例如调用方传入的 className 覆盖组件默认的 p-2） */
export const cn = (...inputs: ClassValue[]) => merge(clsx(inputs))
