/**
 * 可复用的 panel 挂载点（CONTRACT-0.43 §2.6）。
 *
 * 槽位：`run-detail` / `session-detail` / `nav`。没有 plugin 声明对应槽位时
 * 渲染 null，宿主页面无需感知插件是否存在。
 */
import { useMemo } from 'react';
import { cn } from '../../components/ui';
import type { PluginPanelSlot } from '../../gateway/types';
import { t } from '../../i18n';
import { PluginFrame, type PluginFrameContext } from './PluginFrame';
import type { PluginPanelItem } from './plugin-contributions';
import { panelsForSlot, usePluginContributions } from './usePluginContributions';

const EMPTY_METHODS: ReadonlySet<string> = new Set();

/** 已拿到 inventory 的宿主（如 DomainNav）可直接用，避免重复拉取 plugins.list。 */
export function PluginPanelList({
  items,
  methodsByPlugin,
  context,
  className,
  dense = false,
}: {
  items: readonly PluginPanelItem[];
  methodsByPlugin: ReadonlyMap<string, ReadonlySet<string>>;
  context?: PluginFrameContext;
  className?: string;
  dense?: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <div className={cn('plugin-panels flex flex-col', dense ? 'gap-2' : 'gap-3', className)}>
      {items.map((item) => {
        const label = item.title ?? item.id;
        return (
          <section
            key={`${item.pluginId}:${item.id}`}
            className={dense ? 'rounded-md bg-sunken p-2' : 'panel'}
            aria-label={t('plugins.panel.label', { title: label, plugin: item.pluginId })}
          >
            <h3 className={cn('font-semibold text-ink', dense ? 'text-sm' : 'text-md')}>{label}</h3>
            <PluginFrame
              pluginId={item.pluginId}
              entry={item.entry}
              title={label}
              methods={methodsByPlugin.get(item.pluginId) ?? EMPTY_METHODS}
              context={context}
              className={dense ? 'mt-1 h-[140px]' : 'mt-2 h-[320px]'}
            />
          </section>
        );
      })}
    </div>
  );
}

export function PluginPanels({
  slot,
  context,
  className,
  dense = false,
}: {
  slot: PluginPanelSlot;
  context?: PluginFrameContext;
  className?: string;
  dense?: boolean;
}) {
  const { panels, methodsByPlugin } = usePluginContributions();
  const matching = useMemo(() => panelsForSlot(panels, slot), [panels, slot]);
  return (
    <PluginPanelList
      items={matching}
      methodsByPlugin={methodsByPlugin}
      context={context}
      className={className}
      dense={dense}
    />
  );
}
