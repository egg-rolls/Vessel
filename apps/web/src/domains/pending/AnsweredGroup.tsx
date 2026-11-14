/**
 * 「已答」折叠分组：待批页与团队页共用的一个壳子。
 *
 * 只负责「收起来」这一件事：默认折叠、点标题展开。**判据在外面** —— 分组的成员来自
 * `askRowGroups(...).answered`，与载荷剔除是同一个 `settled`，这里不重新判定。
 *
 * 已答的行仍按原样渲染（展开后看得到草稿），输入照旧禁用 —— 分组只改变「一眼看到多少
 * 未答」，不改变任何一行的可写性与载荷归属。
 */
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../components/ui';
import { t } from '../../i18n';

export interface AnsweredGroupProps {
  /** 已答的行数：0 时整组不画 —— 没有已答的题就不该多出一个空标题。 */
  count: number;
  children: ReactNode;
}

/**
 * 默认折叠的「已答」摞：未答永远在上，已答收在这下面。
 *
 * 收起时不渲染子节点（不是 hidden）：已答的行本来就不进载荷，收起来只是少画几张卡。
 */
export function AnsweredGroup({ count, children }: AnsweredGroupProps) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (count === 0) return null;
  return (
    <div className="mt-2 border-t border-line pt-2">
      <Button
        variant="link"
        size="small"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? t('pending.answeredGroup.collapse', { count })
          : t('pending.answeredGroup.expand', { count })}
      </Button>
      {open ? <div id={bodyId}>{children}</div> : null}
    </div>
  );
}
