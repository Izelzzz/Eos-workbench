import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn.ts'

// 聚焦样式：2px 墨色外框，离元素 2px。别的组件也用这一套
// focus-visible:outline-solid 要写出来：outline-hidden 会把外框样式变量设成 none，只加 outline-2 画不出外框
export const focusRing = 'outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ink'

// 每个变体都显式设底色和内边距：现有页面的 styles.css 给所有 button 设了底色、内边距和悬停底色，
// 组件没设的属性会沿用它们
export const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-transparent py-0 font-sans text-control font-medium whitespace-nowrap select-none',
    'transition duration-150 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-35 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0',
    focusRing,
  ),
  {
    variants: {
      variant: {
        // 主操作：墨色底（暗色主题下是浅色）。一组按钮里只有一个
        default: 'bg-ink text-surface hover:bg-ink hover:opacity-86',
        // 次要操作：透明底、细边框
        outline: 'border-line bg-transparent text-ink-2 hover:bg-fill hover:text-ink aria-expanded:bg-fill',
        // 文字按钮、图标按钮：没有边框
        ghost: 'bg-transparent text-ink-2 hover:bg-fill hover:text-ink aria-expanded:bg-fill',
        destructive: 'border-line bg-transparent text-destructive hover:bg-destructive/10',
        link: 'bg-transparent px-0 text-ink underline decoration-ink-3 underline-offset-4 hover:bg-transparent hover:decoration-ink',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 gap-1 rounded-lg px-2.5',
        icon: 'size-8 rounded-lg p-0',
        'icon-sm': 'size-7 rounded-lg p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>

/** 按钮。正在提交时传 disabled，并把文字改成进行中的说法（例如「正在保存…」） */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
