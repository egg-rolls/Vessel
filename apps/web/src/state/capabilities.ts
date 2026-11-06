/** Settings → Capabilities 的纯选择器：三个 tab、搜索与计数。 */
import type {
  CapabilityManifest,
  PluginCatalogItem,
  PluginCatalogKind,
  PluginCatalogScope,
  PluginRuntimeMode,
  PluginRuntimeStatus,
} from '../gateway/types';
import { t } from '../i18n';

export type CapabilityTab = 'methods' | 'tools' | 'plugins';

/**
 * CONTRACT-0.47 §5：catalog 与 `manifest.plugins` 回退的统一渲染行。
 * catalog 行带 scope/mode/restartRequired；旧 gateway 回退行只有 name/enabled。
 */
export interface CatalogPluginRow {
  id: string;
  name: string;
  enabled: boolean;
  version?: string;
  scope?: PluginCatalogScope;
  kind?: PluginCatalogKind;
  mode?: PluginRuntimeMode;
  restartRequired?: boolean;
  status?: PluginRuntimeStatus;
}

/** catalog 主路径：字段原样透传，不在前端推导 kind / restartRequired。 */
export function catalogRowsFromItems(items: readonly PluginCatalogItem[]): CatalogPluginRow[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    enabled: item.enabled,
    version: item.version,
    scope: item.scope,
    kind: item.kind,
    mode: item.mode,
    restartRequired: item.restartRequired,
    ...(item.status !== undefined ? { status: item.status } : {}),
  }));
}

/** catalog 不可用时的回退：同一运行时源的 name/enabled，不扫描磁盘。 */
export function catalogRowsFromManifest(
  plugins: readonly CapabilityManifest['plugins'][number][],
): CatalogPluginRow[] {
  return plugins.map((plugin) => ({
    id: plugin.name,
    name: plugin.name,
    enabled: plugin.enabled,
  }));
}

export const CAPABILITY_TABS: readonly { id: CapabilityTab; labelKey: string }[] = [
  { id: 'methods', labelKey: 'capabilities.tab.methods' },
  { id: 'tools', labelKey: 'capabilities.tab.tools' },
  { id: 'plugins', labelKey: 'capabilities.tab.plugins' },
];

export interface CapabilityCounts {
  methods: number;
  tools: number;
  plugins: number;
  enabledPlugins: number;
  read: number;
  write: number;
  admin: number;
}

export function capabilityCounts(
  manifest: CapabilityManifest,
  plugins: readonly CatalogPluginRow[],
): CapabilityCounts {
  const counts: CapabilityCounts = {
    methods: manifest.methods.length,
    tools: manifest.tools.length,
    plugins: plugins.length,
    enabledPlugins: plugins.filter((plugin) => plugin.enabled).length,
    read: 0,
    write: 0,
    admin: 0,
  };
  for (const method of manifest.methods) {
    counts[method.permission] += 1;
  }
  return counts;
}

export interface CapabilityFilter {
  tab: CapabilityTab;
  query?: string;
}

export interface CapabilityResult {
  tab: CapabilityTab;
  methods: CapabilityManifest['methods'];
  tools: CapabilityManifest['tools'];
  plugins: CatalogPluginRow[];
}

function needleOf(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase();
}

/** 只过滤当前 tab，返回全部 tab 的空数组，便于 UI 共用渲染。 */
export function filterCapabilities(
  manifest: CapabilityManifest,
  pluginRows: readonly CatalogPluginRow[],
  { tab, query }: CapabilityFilter,
): CapabilityResult {
  const needle = needleOf(query);
  const methods =
    tab === 'methods'
      ? manifest.methods.filter((method) => !needle || method.name.toLowerCase().includes(needle))
      : [];
  const tools =
    tab === 'tools'
      ? manifest.tools.filter(
          (tool) =>
            !needle ||
            tool.name.toLowerCase().includes(needle) ||
            (tool.description ?? '').toLowerCase().includes(needle),
        )
      : [];
  const plugins =
    tab === 'plugins'
      ? pluginRows.filter(
          (plugin) =>
            !needle ||
            plugin.name.toLowerCase().includes(needle) ||
            plugin.id.toLowerCase().includes(needle),
        )
      : [];
  return { tab, methods, tools, plugins };
}

/** 方法按权限分组（read → write → admin），组内按名称排序。 */
export function groupMethodsByPermission(
  methods: readonly CapabilityManifest['methods'][number][],
): { permission: 'read' | 'write' | 'admin'; methods: CapabilityManifest['methods'] }[] {
  const order = ['read', 'write', 'admin'] as const;
  return order
    .map((permission) => ({
      permission,
      methods: methods
        .filter((method) => method.permission === permission)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.methods.length > 0);
}

/** tab 上的计数文本（例如 `方法 · 42`）。 */
export function capabilityTabLabel(tab: CapabilityTab, counts: CapabilityCounts): string {
  if (tab === 'methods') return t('capabilities.tab.methodsCount', { count: counts.methods });
  if (tab === 'tools') return t('capabilities.tab.toolsCount', { count: counts.tools });
  return t('capabilities.tab.pluginsCount', {
    enabled: counts.enabledPlugins,
    total: counts.plugins,
  });
}
