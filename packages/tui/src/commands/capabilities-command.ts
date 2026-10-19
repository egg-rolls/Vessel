/**
 * /capabilities —— capability manifest 浏览器（E11 消费端）
 * @module @vessel/tui
 *
 * 数据只来自 RPC `capabilities.list`；外部 agent 通过同一 manifest 自描述发现能力。
 * 未注入 RpcClient（第三方嵌入）时给出明确提示。
 */

import type {
  CapabilityManifestLike,
  CapabilityMethodLike,
  CapabilityPluginLike,
  CapabilityToolLike,
  ReplContext,
} from '../repl-context.js';
import { formatRpcError } from '../rpc.js';
import type { DetailView, ViewAction, ViewActionInvocation } from '../views/types.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE = 'Usage: /capabilities [methods|tools|plugins]';
const DESCRIPTION_MAX = 80;

type Section = 'methods' | 'tools' | 'plugins';
const SECTIONS: readonly Section[] = ['methods', 'tools', 'plugins'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function readMethods(value: unknown): CapabilityMethodLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is CapabilityMethodLike =>
        isRecord(item) &&
        typeof item.name === 'string' &&
        (item.permission === 'read' || item.permission === 'write' || item.permission === 'admin'),
    )
    .map((item) => ({ name: item.name, permission: item.permission }));
}

function readTools(value: unknown): CapabilityToolLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is CapabilityToolLike => isRecord(item) && typeof item.name === 'string')
    .map((item) => ({
      name: item.name,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
    }));
}

function readPlugins(value: unknown): CapabilityPluginLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is CapabilityPluginLike =>
        isRecord(item) && typeof item.name === 'string' && typeof item.enabled === 'boolean',
    )
    .map((item) => ({ name: item.name, enabled: item.enabled }));
}

/** 宽松读取：字段缺失时按空集合处理，不因 manifest 版本差异崩溃 */
export function readCapabilityManifest(value: unknown): CapabilityManifestLike | null {
  if (!isRecord(value)) return null;
  return {
    version: typeof value.version === 'string' ? value.version : '-',
    config_schema_version:
      typeof value.config_schema_version === 'number' ? value.config_schema_version : 0,
    methods: readMethods(value.methods),
    tools: readTools(value.tools),
    plugins: readPlugins(value.plugins),
  };
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 纯函数：默认摘要 */
export function formatCapabilitiesSummary(manifest: CapabilityManifestLike): string {
  const counts = { read: 0, write: 0, admin: 0 };
  for (const method of manifest.methods) counts[method.permission] += 1;

  const enabled = manifest.plugins.filter((plugin) => plugin.enabled).length;

  return [
    `Capabilities (Vessel ${manifest.version}, config_schema_version ${manifest.config_schema_version})`,
    `methods: ${manifest.methods.length} (read ${counts.read} / write ${counts.write} / admin ${counts.admin})`,
    `tools: ${manifest.tools.length} · plugins: ${manifest.plugins.length} (enabled ${enabled})`,
  ].join('\n');
}

/** 纯函数：方法表（按名称排序） */
export function formatCapabilityMethods(methods: CapabilityMethodLike[]): string {
  const sorted = sortByName(methods);
  if (sorted.length === 0) return 'No methods.';
  return [
    `Methods (${sorted.length}):`,
    ...sorted.map((method) => `  ${method.name} [${method.permission}]`),
  ].join('\n');
}

/** 纯函数：工具清单（按名称排序） */
export function formatCapabilityTools(tools: CapabilityToolLike[]): string {
  const sorted = sortByName(tools);
  if (sorted.length === 0) return 'No tools.';
  return [
    `Tools (${sorted.length}):`,
    ...sorted.map((tool) =>
      tool.description
        ? `  ${tool.name} — ${truncate(oneLine(tool.description), DESCRIPTION_MAX)}`
        : `  ${tool.name}`,
    ),
  ].join('\n');
}

/** 纯函数：插件清单（按名称排序） */
export function formatCapabilityPlugins(plugins: CapabilityPluginLike[]): string {
  const sorted = sortByName(plugins);
  if (sorted.length === 0) return 'No plugins.';
  return [
    `Plugins (${sorted.length}):`,
    ...sorted.map((plugin) => `  ${plugin.name} (${plugin.enabled ? 'enabled' : 'disabled'})`),
  ].join('\n');
}

function render(manifest: CapabilityManifestLike, section: Section): string {
  if (section === 'methods') return formatCapabilityMethods(manifest.methods);
  if (section === 'tools') return formatCapabilityTools(manifest.tools);
  return formatCapabilityPlugins(manifest.plugins);
}

/** 视图标签页：summary -> methods -> tools -> plugins -> summary */
export type CapabilityTab = 'summary' | Section;
export const CAPABILITY_TABS: readonly CapabilityTab[] = ['summary', 'methods', 'tools', 'plugins'];

export function nextCapabilityTab(current: CapabilityTab): CapabilityTab {
  const index = CAPABILITY_TABS.indexOf(current);
  return CAPABILITY_TABS[(index + 1) % CAPABILITY_TABS.length] ?? 'summary';
}

function boundedLines(lines: string[], max: number): string[] {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… ${lines.length - max} more`];
}

function methodLines(methods: CapabilityMethodLike[], max: number): string[] {
  const sorted = sortByName(methods);
  if (sorted.length === 0) return ['No methods.'];
  return boundedLines(
    sorted.map((method) => `${method.name} [${method.permission}]`),
    max,
  );
}

function toolLines(tools: CapabilityToolLike[], max: number): string[] {
  const sorted = sortByName(tools);
  if (sorted.length === 0) return ['No tools.'];
  return boundedLines(
    sorted.map((tool) =>
      tool.description
        ? `${tool.name} — ${truncate(oneLine(tool.description), DESCRIPTION_MAX)}`
        : tool.name,
    ),
    max,
  );
}

function pluginLines(plugins: CapabilityPluginLike[], max: number): string[] {
  const sorted = sortByName(plugins);
  if (sorted.length === 0) return ['No plugins.'];
  return boundedLines(
    sorted.map((plugin) => `${plugin.name} (${plugin.enabled ? 'enabled' : 'disabled'})`),
    max,
  );
}

/** 纯函数：manifest -> DetailView（summary 含三节预览；tab 聚焦单节） */
export function buildCapabilitiesDetailView(
  manifest: CapabilityManifestLike,
  tab: CapabilityTab = 'summary',
  maxLines = 80,
): DetailView {
  const counts = { read: 0, write: 0, admin: 0 };
  for (const method of manifest.methods) counts[method.permission] += 1;
  const enabled = manifest.plugins.filter((plugin) => plugin.enabled).length;

  const sections: DetailView['sections'] = [
    {
      title: 'Overview',
      fields: [
        { label: 'Version', value: manifest.version },
        { label: 'Schema version', value: String(manifest.config_schema_version) },
        {
          label: 'Methods',
          value: `${manifest.methods.length} (read ${counts.read} / write ${counts.write} / admin ${counts.admin})`,
        },
        { label: 'Tools', value: String(manifest.tools.length) },
        { label: 'Plugins', value: `${manifest.plugins.length} (enabled ${enabled})` },
      ],
    },
  ];

  const preview = 20;
  if (tab === 'summary') {
    sections.push(
      { title: 'Methods', lines: methodLines(manifest.methods, preview) },
      { title: 'Tools', lines: toolLines(manifest.tools, preview) },
      { title: 'Plugins', lines: pluginLines(manifest.plugins, preview) },
    );
  } else if (tab === 'methods') {
    sections.push({ title: 'Methods', lines: methodLines(manifest.methods, maxLines) });
  } else if (tab === 'tools') {
    sections.push({ title: 'Tools', lines: toolLines(manifest.tools, maxLines) });
  } else {
    sections.push({ title: 'Plugins', lines: pluginLines(manifest.plugins, maxLines) });
  }

  return {
    kind: 'detail',
    title: 'Capabilities',
    badge: { text: `Vessel ${manifest.version}`, tone: 'info' },
    key: tab,
    sections,
    actions: capabilitiesActions(),
  };
}

export function capabilitiesActions(): ViewAction[] {
  return [
    { id: 'cycle', key: 't', label: 'section' },
    { id: 'refresh', key: 'r', label: 'refresh' },
  ];
}

/** 纯函数：没有 RPC 时的诚实不可用视图 */
export function unavailableCapabilitiesView(): DetailView {
  return {
    kind: 'detail',
    title: 'Capabilities',
    badge: { text: 'unavailable', tone: 'warn' },
    sections: [
      {
        title: 'RPC required',
        lines: [
          'RPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to inspect capabilities.',
        ],
      },
    ],
  };
}

type ManifestLoad = { ok: true; manifest: CapabilityManifestLike } | { ok: false; message: string };

/** manifest 读取（命令主体与视图动作共用；错误文本与既有命令一致） */
async function loadCapabilities(ctx: ReplContext): Promise<ManifestLoad> {
  if (!ctx.rpc) {
    return {
      ok: false,
      message:
        'RPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to inspect capabilities.',
    };
  }
  try {
    const raw = await ctx.rpc.request<unknown>('capabilities.list');
    const manifest = readCapabilityManifest(raw);
    if (!manifest) {
      return { ok: false, message: 'Failed to load capabilities: invalid manifest.' };
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, message: `Failed to load capabilities:\n${formatRpcError(error)}` };
  }
}

function envelope(view: DetailView): NonNullable<CommandResult['view']> {
  return { source: 'capabilities', view };
}

/** `/capabilities` 视图动作：t 切节、r 刷新 */
export async function runCapabilitiesViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  const current = CAPABILITY_TABS.find((tab) => tab === invocation.viewKey) ?? 'summary';
  const next: CapabilityTab =
    invocation.actionId === 'cycle' ? nextCapabilityTab(current) : current;

  if (invocation.actionId !== 'cycle' && invocation.actionId !== 'refresh') {
    return {
      handled: true,
      output: `\nUnknown /capabilities view action "${invocation.actionId}".\n`,
    };
  }

  const loaded = await loadCapabilities(ctx);
  if (!loaded.ok) return { handled: true, output: `\n${loaded.message}\n` };
  return { handled: true, view: envelope(buildCapabilitiesDetailView(loaded.manifest, next)) };
}

/** /capabilities 的执行体（导出供单测） */
export async function runCapabilitiesCommand(
  args: string[],
  ctx: ReplContext,
): Promise<CommandResult> {
  if (args.length > 1) return { handled: true, output: `\n${USAGE}\n` };

  const arg = args[0];
  const section: Section | undefined =
    arg === undefined ? undefined : SECTIONS.find((item) => item === arg);
  if (arg !== undefined && !section) {
    return { handled: true, output: `\n${USAGE}\n` };
  }

  const loaded = await loadCapabilities(ctx);
  if (!loaded.ok) {
    return {
      handled: true,
      output: `\n${loaded.message}\n`,
      ...(ctx.rpc ? {} : { view: envelope(unavailableCapabilitiesView()) }),
    };
  }

  const tab: CapabilityTab = section ?? 'summary';
  const body = section
    ? render(loaded.manifest, section)
    : formatCapabilitiesSummary(loaded.manifest);
  return {
    handled: true,
    output: `\n${body}\n`,
    view: envelope(buildCapabilitiesDetailView(loaded.manifest, tab)),
  };
}

export function capabilitiesCommand(): CommandEntry {
  return {
    name: 'capabilities',
    description: 'Show RPC capability manifest (methods / tools / plugins)',
    usage: '/capabilities [methods|tools|plugins]',
    category: 'inspect',
    keywords: ['manifest', 'methods', 'tools', 'plugins'],
    available: (ctx) => Boolean(ctx.rpc),
    unavailableHint: 'RPC required',
    run: (args, ctx) => runCapabilitiesCommand(args, ctx),
    viewAction: (invocation, ctx) => runCapabilitiesViewAction(invocation, ctx),
  };
}
