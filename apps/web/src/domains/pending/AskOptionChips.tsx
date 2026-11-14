import { useRef } from 'react';
import { cn } from '../../components/ui';

/**
 * ask 选项按钮行（0.52）—— 三个地方共用这一个组件。
 *
 * 用户的原话是「三个地方（会话、团队、待批）的三个勾选的单选，我希望是复用的，这样只需要
 * 改一次」。之前这三处各自抄了一份 `<label><input type="radio|checkbox">…</label>`，
 * 于是「单选的选项点第二次要能取消」这种语义改动要改三遍 —— 所以这里收口成一个组件，
 * 语义放纯函数 `toggleAskOption`，组件只负责渲染与「单选二次点击」的事件处理。
 *
 * 一个必须在这里解决的原生行为：**已选中的 radio 再点一次不会触发 `onChange`**（值没变）。
 * 所以单选态的取消只能挂在 `onClick` 上：命中「已选中」时 `preventDefault()` 再回调取消。
 * 不这么写就会出现「看起来能点、实际什么都没发生」的鬼状态 —— 正是用户踩的第一个坑。
 *
 * 第二个坑（0.53）：`preventDefault()` 取消掉一次 radio 激活后，浏览器会执行
 * canceled activation steps，**在事件派发结束后把 checkedness 静默还原成点击前的值**，
 * 正好盖掉 React 这次提交写进去的 `checked=false`；而 React 认为 `checked` 已经提交过、
 * 不会重写。于是背景色（读 `selected`）已经回到未选态，原生圆点却还亮着 —— 两个渲染源分叉。
 *
 * 所以单选的圆点**不再用原生 input 的指示器**（它的 DOM 状态会被浏览器改回去，不可信），
 * 而是从 `picked` 画一个；input 退成 sr-only 的行为/无障碍载体（键盘、互斥、读屏仍靠它）。
 * 反向也要补：`resyncChecked` 用宏任务把原生 checkedness 写成 `picked`（微任务太早，
 * 实测仍会被还原覆盖），否则 DOM 会一直「自认为选中」，下次空格连激活都不派发。
 * 多选没有这两个问题（不 preventDefault，原生取消会真的触发 `onChange`），所以多选的
 * 原生 checkbox 视觉与行为一律保持原样。
 */
export interface AskOptionChipsProps {
  options: readonly string[];
  selected: readonly string[];
  /** true = 复选框（多选）；false = 单选钮，且**再点一次同一项即取消**。 */
  multi: boolean;
  disabled: boolean;
  /** 原生 name：单选组要相同 name 才会互斥。 */
  name: string;
  onToggle: (option: string) => void;
}

interface AskOptionChipProps {
  option: string;
  picked: boolean;
  multi: boolean;
  disabled: boolean;
  name: string;
  onToggle: (option: string) => void;
}

export function AskOptionChips({
  options,
  selected,
  multi,
  disabled,
  name,
  onToggle,
}: AskOptionChipsProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <AskOptionChip
          key={option}
          option={option}
          picked={selected.includes(option)}
          multi={multi}
          disabled={disabled}
          name={name}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

/**
 * 把原生 checkedness 写成 picked 的最新值。必须排在浏览器的 canceled activation steps
 * 之后（宏任务），微任务会被那次还原覆盖掉（实测）。
 */
function resyncChecked(input: HTMLInputElement, picked: () => boolean) {
  setTimeout(() => {
    input.checked = picked();
  }, 0);
}

function AskOptionChip({ option, picked, multi, disabled, name, onToggle }: AskOptionChipProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 定时器里要读到「此刻」的值，而不是闭包里那次渲染的值。
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const readPicked = () => pickedRef.current;

  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-md pointer-coarse:min-h-touch',
        picked ? 'bg-accent-soft text-accent-ink' : 'bg-raised text-ink hover:bg-hover',
        // 单选的 input 是 sr-only，焦点环只能画在外层；用 :focus-visible 保持「键盘才显示」。
        !multi &&
          'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface',
      )}
    >
      <input
        ref={inputRef}
        className={cn(multi ? 'accent-accent' : 'sr-only')}
        type={multi ? 'checkbox' : 'radio'}
        name={name}
        checked={picked}
        disabled={disabled}
        // 单选已选中时 onchange 不触发（值没变），取消只能在这里拦。
        onClick={(event) => {
          if (multi || !picked) return;
          event.preventDefault();
          onToggle(option);
          resyncChecked(event.currentTarget, readPicked);
        }}
        onChange={() => onToggle(option)}
        // 原生：已选中的 radio 按空格连 click 都不派发（实测），Enter 在 radio 上则什么都不做。
        // 所以单选的这两个键一律自己兜（选中/取消都走 onToggle），键盘与鼠标同语义。
        onKeyDown={(event) => {
          if (multi) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle(option);
          if (inputRef.current) resyncChecked(inputRef.current, readPicked);
        }}
      />
      {multi ? null : (
        // 单选圆点的唯一源是 picked（原生指示器的状态会被浏览器改回去，不能当视觉源）。
        <span
          aria-hidden="true"
          className={cn(
            'grid size-4 flex-none place-items-center rounded-full border-2 transition-colors',
            picked ? 'border-accent' : 'border-line-strong',
            disabled && 'opacity-60',
          )}
        >
          <span
            className={cn(
              'size-2 rounded-full transition-colors',
              picked ? 'bg-accent' : 'bg-transparent',
            )}
          />
        </span>
      )}
      <span>{option}</span>
    </label>
  );
}
