/** Settings → Capabilities 的纯选择器：三个 tab、搜索与计数。 */
import type { CapabilityManifest } from '../gateway/types';

export type CapabilityTab = 'methods' | 'tools' | 'plugins';

export const CAPABILITY_TABS: readonly { id: CapabilityTab; label: string }[] = [
  { id: 'methods', label: '方法' },
  { id: 'tools', label: '工具' },
  { id: 'plugins', label: '插件' },
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

export function capabilityCounts(manifest: CapabilityManifest): CapabilityCounts {
  const counts: CapabilityCounts = {
    methods: manifest.methods.length,
    tools: manifest.tools.length,
    plugins: manifest.plugins.length,
    enabledPlugins: manifest.plugins.filter((plugin) => plugin.enabled).length,
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
  plugins: CapabilityManifest['plugins'];
}

function needleOf(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase();
}

/** 只过滤当前 tab，返回全部 tab 的空数组，便于 UI 共用渲染。 */
export function filterCapabilities(
  manifest: CapabilityManifest,
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
      ? manifest.plugins.filter((plugin) => !needle || plugin.name.toLowerCase().includes(needle))
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
  if (tab === 'methods') return `方法 · ${counts.methods}`;
  if (tab === 'tools') return `工具 · ${counts.tools}`;
  return `插件 · ${counts.enabledPlugins}/${counts.plugins}`;
}
