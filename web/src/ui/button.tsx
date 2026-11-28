import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn.ts'

export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent bg-clip-padding py-0 font-sans text-sm font-medium whitespace-nowrap outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        outline: 'border-border bg-card text-foreground hover:bg-muted aria-expanded:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent',
        ghost: 'bg-transparent text-foreground hover:bg-muted aria-expanded:bg-muted',
        destructive: 'bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20',
        link: 'bg-transparent px-0 text-primary underline-offset-4 hover:bg-transparent hover:underline',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 gap-1 px-2.5 text-xs',
        icon: 'size-8 p-0',
        'icon-sm': 'size-7 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

// 每个变体都显式设底色和内边距：现有页面的 styles.css 给所有 button 设了底色、内边距和悬停底色，
// 组件没设的属性会沿用它们
export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>

/** 按钮。正在提交时传 disabled，并把文字改成进行中的说法（例如「正在保存…」） */
export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
