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
 * 不这么写就会出现「看起来能点、实际什么都没发生」的鬼状态 —— 正是用户现在踩的坑。
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
      {options.map((option) => {
        const picked = selected.includes(option);
        return (
          <label
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-md pointer-coarse:min-h-touch',
              picked ? 'bg-accent-soft text-accent-ink' : 'bg-raised text-ink hover:bg-hover',
            )}
            key={option}
          >
            <input
              className="accent-accent"
              type={multi ? 'checkbox' : 'radio'}
              name={name}
              checked={picked}
              disabled={disabled}
              // 单选已选中时 onchange 不触发（值没变），取消只能在这里拦。
              onClick={(event) => {
                if (multi || !picked) return;
                event.preventDefault();
                onToggle(option);
              }}
              onChange={() => onToggle(option)}
            />
            <span>{option}</span>
          </label>
        );
      })}
    </div>
  );
}
