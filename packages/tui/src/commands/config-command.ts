/**
 * /config —— 配置查看（脱敏 + 来源 + YAML 路径）
 * @module @vessel/tui
 *
 * 数据只来自 RPC `config.get` / `config.sources`（E12/E14）。
 * 服务端已脱敏；TUI 再做一层 redactForDisplay 兜底。
 * 不提供修改入口：写配置走 `vessel config init` / 编辑 YAML。
 */

import type { ReplContext } from '../repl-context.js';
import { formatRpcError, redactForDisplay } from '../rpc.js';
import type { CommandEntry, CommandResult } from './commands.js';

const USAGE = 'Usage: /config [show|path] [--sources] [--json]';

/** ConfigSnapshot 的结构子集（web 可能返回额外字段） */
export interface ConfigSnapshotLike {
  schema_version?: number;
  config: Record<string, unknown>;
  sources?: Record<string, unknown>;
  paths?: { user?: string; project?: string };
  tenant_id?: string;
  tenant_overlay_keys?: string[];
  validation?: {
    errors?: Array<{ path?: string; message?: string }>;
    warnings?: Array<{ path?: string; message?: string }>;
  };
}

interface ConfigOptions {
  action: 'show' | 'path';
  sources: boolean;
  json: boolean;
}

type ParseResult = { ok: true; value: ConfigOptions } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readValidationItem(item: Record<string, unknown>): {
  path?: string;
  message?: string;
} {
  return {
    ...(typeof item.path === 'string' ? { path: item.path } : {}),
    ...(typeof item.message === 'string' ? { message: item.message } : {}),
  };
}

/** 宽松解析：既接受 ConfigSnapshot，也接受 { config, validation } 包装 */
export function readConfigSnapshot(value: unknown): ConfigSnapshotLike | null {
  if (!isRecord(value)) return null;
  const config = isRecord(value.config) ? value.config : value;
  return {
    ...(typeof value.schema_version === 'number' ? { schema_version: value.schema_version } : {}),
    config,
    ...(isRecord(value.sources) ? { sources: value.sources } : {}),
    ...(isRecord(value.paths)
      ? {
          paths: {
            ...(typeof value.paths.user === 'string' ? { user: value.paths.user } : {}),
            ...(typeof value.paths.project === 'string' ? { project: value.paths.project } : {}),
          },
        }
      : {}),
    ...(typeof value.tenant_id === 'string' ? { tenant_id: value.tenant_id } : {}),
    ...(Array.isArray(value.tenant_overlay_keys)
      ? {
          tenant_overlay_keys: value.tenant_overlay_keys.filter(
            (key): key is string => typeof key === 'string',
          ),
        }
      : {}),
    ...(isRecord(value.validation)
      ? {
          validation: {
            ...(Array.isArray(value.validation.errors)
              ? { errors: value.validation.errors.filter(isRecord).map(readValidationItem) }
              : {}),
            ...(Array.isArray(value.validation.warnings)
              ? { warnings: value.validation.warnings.filter(isRecord).map(readValidationItem) }
              : {}),
          },
        }
      : {}),
  };
}

export function parseConfigArgs(args: string[]): ParseResult {
  let action: 'show' | 'path' = 'show';
  let sources = false;
  let json = false;

  for (const arg of args) {
    if (arg === 'show') continue;
    if (arg === 'path') {
      if (action === 'show') action = 'path';
      continue;
    }
    if (arg === '--sources') {
      sources = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    return { ok: false, message: `${USAGE} (unknown argument "${arg}")` };
  }

  return { ok: true, value: { action, sources, json } };
}

function flattenLeaves(
  value: unknown,
  prefix: string,
  out: Map<string, unknown>,
): Map<string, unknown> {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenLeaves(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out.set(prefix, value);
  return out;
}

function displayValue(value: unknown): string {
  if (value === undefined) return '-';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length === 0 ? '""' : value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function readErrors(snapshot: ConfigSnapshotLike): string[] {
  const errors = snapshot.validation?.errors ?? [];
  return errors.map((error) => `${error.path ?? '-'}: ${error.message ?? 'invalid'}`);
}

/** 纯函数：摘要（默认 /config show） */
export function formatConfigSummary(snapshot: ConfigSnapshotLike): string {
  const config = snapshot.config;
  const provider = isRecord(config.provider) ? config.provider : {};
  const session = isRecord(config.session) ? config.session : {};
  const trace = isRecord(config.trace) ? config.trace : {};
  const tenant =
    snapshot.tenant_id ?? (isRecord(config.tenant) ? String(config.tenant.default ?? '-') : '-');

  const lines: string[] = [];
  const errors = readErrors(snapshot);
  if (errors.length > 0) {
    lines.push('✗ Configuration errors:');
    for (const error of errors) lines.push(`  - ${error}`);
    lines.push('');
  }

  lines.push(`Config (schema_version ${snapshot.schema_version ?? '-'}, tenant ${tenant})`);
  lines.push(`  provider.name:      ${displayValue(provider.name)}`);
  lines.push(`  provider.model:     ${displayValue(provider.model)}`);
  lines.push(`  provider.baseUrl:   ${displayValue(provider.baseUrl)}`);
  lines.push(`  dataDir:            ${displayValue(config.dataDir)}`);
  lines.push(`  session.backend:    ${displayValue(session.backend)}`);
  lines.push(`  trace.enabled:      ${displayValue(trace.enabled)}`);
  lines.push(`  trace.level:        ${displayValue(trace.level)}`);
  lines.push(`  trace.retentionDays: ${displayValue(trace.retentionDays)}`);

  const warnings = snapshot.validation?.warnings ?? [];
  if (warnings.length > 0) {
    lines.push('');
    lines.push('⚠ Configuration warnings:');
    for (const warning of warnings) {
      lines.push(`  - ${warning.path ?? '-'}: ${warning.message ?? 'warning'}`);
    }
  }

  lines.push('');
  lines.push(...formatPaths(snapshot));
  return lines.join('\n');
}

function formatPaths(snapshot: ConfigSnapshotLike): string[] {
  return [
    `User config:    ${snapshot.paths?.user ?? '~/.vessel/config.yaml'}`,
    `Project config: ${snapshot.paths?.project ?? './vessel.yaml'}`,
    'Create user config: vessel config init',
  ];
}

/** 纯函数：--sources（逐叶子键 + 来源标签） */
export function formatConfigSources(snapshot: ConfigSnapshotLike): string {
  const leaves = flattenLeaves(snapshot.config, '', new Map());
  const sources = snapshot.sources ?? {};
  const overlays = new Set(snapshot.tenant_overlay_keys ?? []);
  const keys = [...leaves.keys()].sort();

  if (keys.length === 0) return 'No config keys.';

  const lines = [`Config sources (${keys.length} keys):`];
  for (const key of keys) {
    const rawSource = sources[key];
    const source = typeof rawSource === 'string' ? rawSource : '?';
    const overlay = overlays.has(key) ? ' +tenant' : '';
    lines.push(
      `  ${key.padEnd(36)} ${displayValue(leaves.get(key)).padEnd(24)} (${source}${overlay})`.trimEnd(),
    );
  }
  return lines.join('\n');
}

/** 纯函数：/config path */
export function formatConfigPaths(snapshot: ConfigSnapshotLike): string {
  return formatPaths(snapshot).join('\n');
}

/**
 * 展示用快照：config 值脱敏，但 `sources` 的 key 是配置路径、value 是来源枚举，
 * 不能被键名规则误伤（例如 `provider.apiKey` 的来源标签仍应是 `env`）。
 */
function redactSnapshotForDisplay(snapshot: ConfigSnapshotLike): ConfigSnapshotLike {
  const safe = redactForDisplay(snapshot);
  return {
    ...safe,
    ...(snapshot.sources ? { sources: snapshot.sources } : {}),
    ...(snapshot.tenant_overlay_keys ? { tenant_overlay_keys: snapshot.tenant_overlay_keys } : {}),
  };
}

async function loadSources(
  ctx: ReplContext,
  snapshot: ConfigSnapshotLike,
): Promise<ConfigSnapshotLike> {
  if (!ctx.rpc) return snapshot;
  try {
    const raw = await ctx.rpc.request<unknown>('config.sources');
    if (!isRecord(raw)) return snapshot;
    const sources = isRecord(raw.sources) ? raw.sources : raw;
    return {
      ...snapshot,
      sources: { ...(snapshot.sources ?? {}), ...sources },
      ...(Array.isArray(raw.tenant_overlay_keys)
        ? {
            tenant_overlay_keys: raw.tenant_overlay_keys.filter(
              (key): key is string => typeof key === 'string',
            ),
          }
        : {}),
    };
  } catch {
    // config.sources 失败时退回 config.get 内嵌的来源，不阻塞查看
    return snapshot;
  }
}

/** /config 的执行体（导出供单测） */
export async function runConfigCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const parsed = parseConfigArgs(args);
  if (!parsed.ok) return { handled: true, output: `\n${parsed.message}\n` };
  const options = parsed.value;

  if (!ctx.rpc) {
    return {
      handled: true,
      output:
        '\nRPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to inspect config.\n',
    };
  }

  try {
    const raw = await ctx.rpc.request<unknown>('config.get');
    let snapshot = readConfigSnapshot(raw);
    if (!snapshot) {
      return { handled: true, output: '\nFailed to load config: invalid snapshot.\n' };
    }

    if (options.sources) snapshot = await loadSources(ctx, snapshot);
    const safe = redactSnapshotForDisplay(snapshot);

    if (options.json) {
      return { handled: true, output: `\n${JSON.stringify(safe, null, 2)}\n` };
    }
    if (options.action === 'path') {
      return { handled: true, output: `\n${formatConfigPaths(safe)}\n` };
    }
    const body = options.sources
      ? `${formatConfigSummary(safe)}\n\n${formatConfigSources(safe)}`
      : formatConfigSummary(safe);
    return { handled: true, output: `\n${body}\n` };
  } catch (error) {
    return { handled: true, output: `\nFailed to load config:\n${formatRpcError(error)}\n` };
  }
}

export function configCommand(): CommandEntry {
  return {
    name: 'config',
    description: 'Show config (masked) and YAML config paths',
    usage: '/config [show|path] [--sources] [--json]',
    run: (args, ctx) => runConfigCommand(args, ctx),
  };
}
