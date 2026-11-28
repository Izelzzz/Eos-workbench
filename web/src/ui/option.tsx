import { createContext, useContext, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from './cn.ts'
import { CheckIcon } from './icons.tsx'

/** 一组选项的答案：选了某个选项，或在「其他」里写了字（原样保留，提交时只有空白的要当成没回答）。两者只能有一个，没有答案时是 undefined */
export type OptionAnswer = { kind: 'option'; value: string } | { kind: 'other'; text: string }

type Group = {
  name: string
  answer: OptionAnswer | undefined
  set: (a: OptionAnswer | undefined) => void
}
const GroupContext = createContext<Group | undefined>(undefined)
const useGroup = (part: string) => {
  const g = useContext(GroupContext)
  if (g === undefined) throw new Error(`${part} 要放在 OptionGroup 里`)
  return g
}

export type OptionGroupProps = Omit<ComponentProps<'fieldset'>, 'onChange' | 'defaultValue'> & {
  legend: ReactNode
  /** 受控：当前答案。不传时组件自己记 */
  value?: OptionAnswer | undefined
  /** 非受控时的初始答案 */
  defaultValue?: OptionAnswer
  onValueChange?: (answer: OptionAnswer | undefined) => void
}

/**
 * 一组单选项：一行一个，选中的是墨色边框加实心的勾，不用浏览器自带的单选圆点。
 * 用原生的 radio：键盘上下键切换、读屏软件按单选组读。
 * 答案只有一个（OptionAnswer）：在「其他」里写字会取消已选的选项，选了选项会清空「其他」。受控和非受控用法都由组件保证。
 */
export function OptionGroup(allProps: OptionGroupProps) {
  const { className, legend, children, name: nameProp, value, defaultValue, onValueChange, ...props } = allProps
  const id = useId()
  // 同一组 radio 的 name：表单要提交时由调用方传，否则自动生成
  const name = nameProp ?? id
  const [own, setOwn] = useState<OptionAnswer | undefined>(defaultValue)
  const controlled = 'value' in allProps
  const answer = controlled ? value : own
  const set = (a: OptionAnswer | undefined) => {
    if (!controlled) setOwn(a)
    onValueChange?.(a)
  }
  return (
    <GroupContext value={{ name, answer, set }}>
      <fieldset data-slot="option-group" className={cn('m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0', className)} {...props}>
        <legend className="mb-2.5 p-0 text-md font-semibold text-ink">{legend}</legend>
        {children}
      </fieldset>
    </GroupContext>
  )
}

export type OptionProps = Omit<ComponentProps<'input'>, 'type' | 'title' | 'value' | 'name' | 'checked' | 'defaultChecked' | 'onChange'> & {
  value: string
  title: ReactNode
  /** 选了会怎样：一句话，没有就不写 */
  description?: ReactNode
  /** 标题旁的小标签，例如「推荐」 */
  badge?: ReactNode
}

export function Option({ className, title, description, badge, value, ...props }: OptionProps) {
  const g = useGroup('Option')
  const checked = g.answer?.kind === 'option' && g.answer.value === value
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
      <input type="radio" className="peer sr-only" name={g.name} value={value} checked={checked} onChange={() => g.set({ kind: 'option', value })} {...props} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
          {title}
          {badge}
        </span>
        {description !== undefined && <span className="text-sm text-ink-3">{description}</span>}
      </span>
      <span
        aria-hidden="true"
        className="grid size-4.5 shrink-0 place-items-center rounded-full border-tick border-line text-transparent peer-checked:border-ink peer-checked:bg-ink peer-checked:text-surface"
      >
        <CheckIcon width={12} height={12} />
      </span>
    </label>
  )
}

/** 选项下面的「其他」输入：和选项同宽同圆角，虚线边框，聚焦时变成实线墨色。读屏名字默认是「其他」 */
export function OptionOther({ className, ...props }: Omit<ComponentProps<'input'>, 'value' | 'defaultValue' | 'onChange'>) {
  const g = useGroup('OptionOther')
  return (
    <input
      type="text"
      data-slot="option-other"
      aria-label="其他"
      value={g.answer?.kind === 'other' ? g.answer.text : ''}
      onChange={e => g.set(e.target.value === '' ? undefined : { kind: 'other', text: e.target.value })}
      className={cn(
        'h-11 w-full min-w-0 rounded-box border border-dashed border-line bg-transparent px-3.5 font-sans text-lg text-ink outline-hidden placeholder:text-ink-3 focus:border-solid focus:border-ink sm:text-base',
        className,
      )}
      {...props}
    />
  )
}
