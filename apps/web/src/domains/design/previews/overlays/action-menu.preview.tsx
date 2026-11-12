/**
 * 行级菜单（components/ActionMenu）：aria-haspopup / 方向键 / Home / End / Esc，
 * 点击外部关闭并把焦点还给触发按钮。只渲染：每个菜单项的回调都是空的。
 */
import { ActionMenu, type ActionMenuItem } from '../../../../components/ActionMenu';
import { t } from '../../../../i18n';
import type { PreviewMeta } from '../../preview-registry';

export const preview: PreviewMeta = {
  title: 'ActionMenu',
  descriptionKey: 'designLab.preview.actionMenu.desc',
  group: 'overlays',
  order: 40,
};

/** 菜单文案走 i18n，所以在渲染期构造（模块级 t() 不会跟着语言切换刷新）。 */
function menuItems(): readonly ActionMenuItem[] {
  return [
    { id: 'rename', label: t('designLab.preview.actionMenu.rename'), onSelect: () => undefined },
    {
      id: 'duplicate',
      label: t('designLab.preview.actionMenu.duplicate'),
      onSelect: () => undefined,
    },
    {
      id: 'archive',
      label: t('designLab.preview.actionMenu.archive'),
      disabled: true,
      onSelect: () => undefined,
    },
    {
      id: 'delete',
      label: t('designLab.preview.actionMenu.delete'),
      danger: true,
      onSelect: () => undefined,
    },
  ];
}

export default function ActionMenuPreview() {
  return (
    <div className="flex items-center gap-3">
      <ActionMenu items={menuItems()} />
      <span className="font-mono text-2xs text-faint">ActionMenu</span>
    </div>
  );
}
