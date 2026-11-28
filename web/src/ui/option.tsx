import type { ChangeEvent, ComponentProps, ReactNode } from 'react'
import { cn } from './cn.ts'
import { CheckIcon } from './icons.tsx'

/**
 * 一组单选项：一行一个，选中的是墨色边框加实心的勾，不用浏览器自带的单选圆点。
 * 用原生的 radio：键盘上下键切换、读屏软件按单选组读。同一组的 Option 传同一个 name。
 * 选项和「其他」只能有一个答案：在「其他」里输入文字会取消已选的选项，选了选项会清空「其他」。
 * 这里按非受控用法在页面上直接处理；用受控的 checked、value 时，调用方要在自己的状态里照样处理。
 */
export function OptionGroup({ className, legend, children, onChange, ...props }: ComponentProps<'fieldset'> & { legend: ReactNode }) {
  const exclusive = (e: ChangeEvent<HTMLFieldSetElement>) => {
    const target = e.target as unknown as HTMLInputElement
    const group = e.currentTarget
    if (target.type === 'radio' && target.checked) {
      for (const other of group.querySelectorAll<HTMLInputElement>('[data-slot=option-other]')) other.value = ''
    } else if (target.dataset.slot === 'option-other' && target.value.trim() !== '') {
      for (const radio of group.querySelectorAll<HTMLInputElement>('input[type=radio]')) radio.checked = false
    }
    onChange?.(e)
  }
  return (
    <fieldset data-slot="option-group" className={cn('m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0', className)} onChange={exclusive} {...props}>
      <legend className="mb-2.5 p-0 text-md font-semibold text-ink">{legend}</legend>
      {children}
    </fieldset>
  )
}

export type OptionProps = Omit<ComponentProps<'input'>, 'type' | 'title'> & {
  title: ReactNode
  /** 选了会怎样：一句话，没有就不写 */
  description?: ReactNode
  /** 标题旁的小标签，例如「推荐」 */
  badge?: ReactNode
}

export function Option({ className, title, description, badge, ...props }: OptionProps) {
  return (
    <label
      data-slot="option"
      className={cn(
        'relative flex cursor-pointer items-center gap-3 rounded-box border border-line px-3.5 py-2.75 transition duration-150 motion-reduce:transition-none hover:bg-fill has-disabled:hover:bg-transparent',
        'has-checked:border-ink has-checked:bg-surface has-checked:shadow-selected has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink has-focus-visible:outline-solid',
        'has-disabled:cursor-not-allowed has-disabled:opacity-35',
        className,
      )}
    >
      <input type="radio" className="peer sr-only" {...props} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
          {title}
          {badge}
        </span>
        {description !== undefined && <span className="text-sm text-ink-3">{description}</span>}
      </span>
      <span
        aria-hidden="true"
        className="grid size-4.5 shrink-0 place-items-center rounded-full border border-line text-transparent peer-checked:border-ink peer-checked:bg-ink peer-checked:text-surface"
      >
        <CheckIcon width={12} height={12} strokeWidth={2.5} />
      </span>
    </label>
  )
}

/** 选项下面的「其他」输入：和选项同宽同圆角，虚线边框，聚焦时变成实线墨色 */
export function OptionOther({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type="text"
      data-slot="option-other"
      className={cn(
        'h-11 w-full min-w-0 rounded-box border border-dashed border-line bg-transparent px-3.5 font-sans text-lg text-ink outline-hidden placeholder:text-ink-3 focus:border-solid focus:border-ink sm:text-base',
        className,
      )}
      {...props}
    />
  )
}
