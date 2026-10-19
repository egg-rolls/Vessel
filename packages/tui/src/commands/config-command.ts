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
import type { DetailView, TableView, ViewAction, ViewActionInvocation } from '../views/types.js';
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

/** 纯函数：详情动作（s 切 sources；path 视图没有 sources） */
export function configDetailActions(action: 'show' | 'path'): ViewAction[] {
  if (action === 'path') return [{ id: 'refresh', key: 'r', label: 'refresh' }];
  return [
    { id: 'sources', key: 's', label: 'sources' },
    { id: 'refresh', key: 'r', label: 'refresh' },
  ];
}

/** sources 表格动作：s 回到摘要 */
export function configSourcesActions(): ViewAction[] {
  return [
    { id: 'sources', key: 's', label: 'summary' },
    { id: 'refresh', key: 'r', label: 'refresh' },
  ];
}

/** 纯函数：摘要/路径详情（字段分区，路径也走同一详情） */
export function buildConfigDetailView(
  snapshot: ConfigSnapshotLike,
  action: 'show' | 'path' = 'show',
): DetailView {
  const config = snapshot.config;
  const provider = isRecord(config.provider) ? config.provider : {};
  const session = isRecord(config.session) ? config.session : {};
  const trace = isRecord(config.trace) ? config.trace : {};
  const tenant =
    snapshot.tenant_id ?? (isRecord(config.tenant) ? String(config.tenant.default ?? '-') : '-');
  const errors = readErrors(snapshot);
  const warnings = snapshot.validation?.warnings ?? [];

  const pathsSection: DetailView['sections'][number] = {
    title: 'Paths',
    fields: [
      { label: 'User config', value: snapshot.paths?.user ?? '~/.vessel/config.yaml' },
      { label: 'Project config', value: snapshot.paths?.project ?? './vessel.yaml' },
      { label: 'Create user config', value: 'vessel config init' },
    ],
  };

  if (action === 'path') {
    return {
      kind: 'detail',
      title: 'Config paths',
      badge: { text: `tenant ${tenant}`, tone: 'info' },
      key: 'paths',
      sections: [pathsSection],
      actions: configDetailActions('path'),
    };
  }

  const sections: DetailView['sections'] = [];
  if (errors.length > 0 || warnings.length > 0) {
    sections.push({
      title: 'Validation',
      lines: [
        ...errors.map((error) => `✗ ${error}`),
        ...warnings.map((warning) => `⚠ ${warning.path ?? '-'}: ${warning.message ?? 'warning'}`),
      ],
    });
  }

  sections.push(
    {
      title: 'Provider',
      fields: [
        { label: 'name', value: displayValue(provider.name) },
        { label: 'model', value: displayValue(provider.model) },
        { label: 'baseUrl', value: displayValue(provider.baseUrl) },
      ],
    },
    {
      title: 'Session',
      fields: [
        { label: 'backend', value: displayValue(session.backend) },
        { label: 'dataDir', value: displayValue(config.dataDir) },
      ],
    },
    {
      title: 'Trace',
      fields: [
        { label: 'enabled', value: displayValue(trace.enabled) },
        { label: 'level', value: displayValue(trace.level) },
        { label: 'retentionDays', value: displayValue(trace.retentionDays) },
      ],
    },
    pathsSection,
  );

  return {
    kind: 'detail',
    title: 'Config',
    badge: {
      text: `schema ${snapshot.schema_version ?? '-'} · tenant ${tenant}`,
      tone: errors.length > 0 ? 'danger' : warnings.length > 0 ? 'warn' : 'info',
    },
    key: 'detail',
    sections,
    actions: configDetailActions('show'),
  };
}

/** 纯函数：逐叶子键 -> TableView（值已脱敏） */
export function buildConfigSourcesTableView(snapshot: ConfigSnapshotLike): TableView {
  const leaves = flattenLeaves(snapshot.config, '', new Map());
  const sources = snapshot.sources ?? {};
  const overlays = new Set(snapshot.tenant_overlay_keys ?? []);
  const keys = [...leaves.keys()].sort();

  const rows = keys.map((key) => {
    const rawSource = sources[key];
    return {
      key,
      cells: {
        key,
        value: displayValue(leaves.get(key)),
        source: typeof rawSource === 'string' ? rawSource : '?',
        overlay: overlays.has(key) ? '+tenant' : '',
      },
    };
  });

  return {
    kind: 'table',
    title: 'Config sources',
    columns: [
      { key: 'key', header: 'KEY', minWidth: 24, priority: 1 },
      { key: 'value', header: 'VALUE', minWidth: 16, priority: 1 },
      { key: 'source', header: 'SOURCE', width: 8, priority: 2 },
      { key: 'overlay', header: 'OVERLAY', width: 8, priority: 2 },
    ],
    rows,
    actions: configSourcesActions(),
    ...(rows[0] ? { initialKey: rows[0].key } : {}),
    emptyText: 'No config keys.',
    meta: `${keys.length} keys`,
    key: 'sources',
  };
}

/** 纯函数：没有 RPC 时的诚实不可用视图 */
export function unavailableConfigView(): DetailView {
  return {
    kind: 'detail',
    title: 'Config',
    badge: { text: 'unavailable', tone: 'warn' },
    sections: [
      {
        title: 'RPC required',
        lines: [
          'RPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to inspect config.',
        ],
      },
    ],
  };
}

type ConfigLoad = { ok: true; snapshot: ConfigSnapshotLike } | { ok: false; message: string };

/** 读取并脱敏快照（命令主体与视图动作共用） */
async function loadSafeConfig(
  ctx: ReplContext,
  options: { withSources: boolean },
): Promise<ConfigLoad> {
  if (!ctx.rpc) {
    return {
      ok: false,
      message:
        'RPC control plane is not available. Start Vessel with a gateway connection (--connect <url>) to inspect config.',
    };
  }
  try {
    const raw = await ctx.rpc.request<unknown>('config.get');
    let snapshot = readConfigSnapshot(raw);
    if (!snapshot) return { ok: false, message: 'Failed to load config: invalid snapshot.' };
    if (options.withSources) snapshot = await loadSources(ctx, snapshot);
    return { ok: true, snapshot: redactSnapshotForDisplay(snapshot) };
  } catch (error) {
    return { ok: false, message: `Failed to load config:\n${formatRpcError(error)}` };
  }
}

function envelope(view: DetailView | TableView): NonNullable<CommandResult['view']> {
  return { source: 'config', view };
}

/** `/config` 视图动作：s 在摘要/sources 表格间切换、r 刷新 */
export async function runConfigViewAction(
  invocation: ViewActionInvocation,
  ctx: ReplContext,
): Promise<CommandResult> {
  if (invocation.actionId === 'sources') {
    // 当前是 sources 表格 -> 回摘要；否则加载 sources。
    const loaded = await loadSafeConfig(ctx, {
      withSources: invocation.viewKind !== 'table',
    });
    if (!loaded.ok) return { handled: true, output: `\n${loaded.message}\n` };
    return {
      handled: true,
      view: envelope(
        invocation.viewKind === 'table'
          ? buildConfigDetailView(loaded.snapshot, 'show')
          : buildConfigSourcesTableView(loaded.snapshot),
      ),
    };
  }

  if (invocation.actionId === 'refresh') {
    const wantsSources = invocation.viewKey === 'sources';
    const loaded = await loadSafeConfig(ctx, { withSources: wantsSources });
    if (!loaded.ok) return { handled: true, output: `\n${loaded.message}\n` };
    if (wantsSources) {
      return { handled: true, view: envelope(buildConfigSourcesTableView(loaded.snapshot)) };
    }
    return {
      handled: true,
      view: envelope(
        buildConfigDetailView(loaded.snapshot, invocation.viewKey === 'paths' ? 'path' : 'show'),
      ),
    };
  }

  return {
    handled: true,
    output: `\nUnknown /config view action "${invocation.actionId}".\n`,
  };
}

/** /config 的执行体（导出供单测） */
export async function runConfigCommand(args: string[], ctx: ReplContext): Promise<CommandResult> {
  const parsed = parseConfigArgs(args);
  if (!parsed.ok) return { handled: true, output: `\n${parsed.message}\n` };
  const options = parsed.value;

  const loaded = await loadSafeConfig(ctx, { withSources: options.sources });
  if (!loaded.ok) {
    return {
      handled: true,
      output: `\n${loaded.message}\n`,
      ...(ctx.rpc ? {} : { view: envelope(unavailableConfigView()) }),
    };
  }
  const safe = loaded.snapshot;

  // JSON 是机器可读出口：保持纯文本，不返回 view。
  if (options.json) {
    return { handled: true, output: `\n${JSON.stringify(safe, null, 2)}\n` };
  }
  if (options.action === 'path') {
    return {
      handled: true,
      output: `\n${formatConfigPaths(safe)}\n`,
      view: envelope(buildConfigDetailView(safe, 'path')),
    };
  }
  if (options.sources) {
    return {
      handled: true,
      output: `\n${formatConfigSummary(safe)}\n\n${formatConfigSources(safe)}\n`,
      view: envelope(buildConfigSourcesTableView(safe)),
    };
  }
  return {
    handled: true,
    output: `\n${formatConfigSummary(safe)}\n`,
    view: envelope(buildConfigDetailView(safe, 'show')),
  };
}

export function configCommand(): CommandEntry {
  return {
    name: 'config',
    description: 'Show config (masked) and YAML config paths',
    usage: '/config [show|path] [--sources] [--json]',
    category: 'config',
    keywords: ['yaml', 'provider', 'sources'],
    available: (ctx) => Boolean(ctx.rpc),
    unavailableHint: 'RPC required',
    run: (args, ctx) => runConfigCommand(args, ctx),
    viewAction: (invocation, ctx) => runConfigViewAction(invocation, ctx),
  };
}
