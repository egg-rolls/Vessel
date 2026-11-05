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
import { panelsForSlot, usePluginContributions } from './usePluginContributions';

const EMPTY_METHODS: ReadonlySet<string> = new Set();

export function PluginPanels({
  slot,
  context,
  className,
}: {
  slot: PluginPanelSlot;
  context?: PluginFrameContext;
  className?: string;
}) {
  const { panels, methodsByPlugin } = usePluginContributions();
  const matching = useMemo(() => panelsForSlot(panels, slot), [panels, slot]);
  if (matching.length === 0) return null;

  return (
    <div className={cn('plugin-panels flex flex-col gap-3', className)}>
      {matching.map((item) => {
        const label = item.title ?? item.id;
        return (
          <section
            key={`${item.pluginId}:${item.id}`}
            className="panel"
            aria-label={t('plugins.panel.label', { title: label, plugin: item.pluginId })}
          >
            <h3 className="text-md font-semibold text-ink">{label}</h3>
            <PluginFrame
              pluginId={item.pluginId}
              entry={item.entry}
              title={label}
              methods={methodsByPlugin.get(item.pluginId) ?? EMPTY_METHODS}
              context={context}
              className="mt-2 h-[320px]"
            />
          </section>
        );
      })}
    </div>
  );
}
