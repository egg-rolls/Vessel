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

  if (!ctx.rpc) {
    return {
      handled: true,
      output:
        '\nRPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to inspect capabilities.\n',
    };
  }

  try {
    const raw = await ctx.rpc.request<unknown>('capabilities.list');
    const manifest = readCapabilityManifest(raw);
    if (!manifest) {
      return { handled: true, output: '\nFailed to load capabilities: invalid manifest.\n' };
    }
    const body = section ? render(manifest, section) : formatCapabilitiesSummary(manifest);
    return { handled: true, output: `\n${body}\n` };
  } catch (error) {
    return {
      handled: true,
      output: `\nFailed to load capabilities:\n${formatRpcError(error)}\n`,
    };
  }
}

export function capabilitiesCommand(): CommandEntry {
  return {
    name: 'capabilities',
    description: 'Show RPC capability manifest (methods / tools / plugins)',
    usage: '/capabilities [methods|tools|plugins]',
    run: (args, ctx) => runCapabilitiesCommand(args, ctx),
  };
}
