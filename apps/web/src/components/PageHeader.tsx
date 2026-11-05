import type { ReactNode } from 'react';
import { EntityHeader } from './ui';

/**
 * 页面标题：唯一 h1，经 `EntityHeader` 的四槽位模型渲染。
 *
 * 槽位归属（DESIGN-0.33.0 §1）：
 * - `title` = Identity，页级 L0（22px serif）。全站页面标题因此与团队群聊页一致，
 *   不再有一套 16px sans 的「另一个 h1」。
 * - `description` **不是**头部字段 —— I4 规定头部只放「名字 / 直接父级名 / 状态」，
 *   自由文本属 Detail。这里保留它，但渲染在 Identity 区之外（标题块下方独立一行），
 *   因为 4 个列表页靠它交代页面用途，丢了是内容损失。
 *
 * **不显示当前租户**：`AppBar` 的右侧已经在全局显示它（`nav.tenant`），
 * 每个页面再挂一枚 chip 是重复信息。
 *
 * 0.46：顶层页统一迁移到 `PageScaffold`；本组件只保留给 teams 的既有调用点
 * （`TeamEditView` 等）。非 teams 的页面不得再新增调用。
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  /**
   * 已不渲染（见上方说明）。保留在签名里是为了不让 teams 的调用方跟着改；
   * 删它要级联改调用点的 props，收益不抵 churn。
   */
  tenantId?: string | null;
  /**
   * @deprecated 0.46：标题行只放标题与说明。控件（动作 / 筛选 / tab / 搜索）
   * 属于 content 区，应放进 `TableToolbar` 或 Section header。
   */
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2.5">
      <EntityHeader title={title} actions={actions} />
      {description && (
        <div className="max-w-prose text-md leading-normal text-muted">{description}</div>
      )}
    </header>
  );
}
