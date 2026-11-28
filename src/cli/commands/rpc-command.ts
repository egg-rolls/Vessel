/**
 * `vessel rpc list [--node <id>] [--json]` — AX 自服务 · 能力发现。
 *
 * capabilities.list 的 CLI 包装：列出控制面 RPC 方法 + 参数/返回 schema 摘要，
 * agent / 用户不用翻源码就能发现「这个 node 能调什么」。数据源唯一 =
 * gateway `capabilities.list`（与 vessel 桥 / WebUI 同源）；本命令只读：
 * 不 bootstrap、不获取 tenant 写锁、不输出任何密钥。
 *
 * 目标解析与 model / errors 同口径（resolveControlPlaneTarget）：
 * - 缺省 attach 本地运行中的 gateway（严格本舰队 dataDir；--data-dir /
 *   --user-config 经全局 env 生效）；
 * - `--node <id>` 经平台代理 `/nodes/<id>/v1/rpc` 定向（q-node-target 同机制）；
 * - `--connect <url>` 远端直连；两者组合 = 远端平台代理。
 *
 * `--json` 输出完整 manifest（纯数据、无 ANSI、无包装）+ 目标元信息；
 * 人类可读输出走 ui + i18n，数据行保持英文（与 model 命令同约定）。
 *
 * @module vessel/commands/rpc-command
 */

import { t } from '../../i18n';
import { RpcClientError } from '../../rpc';
import {
  type ControlPlaneTarget,
  type ControlPlaneTargetOptions,
  resolveControlPlaneTarget,
} from '../control-plane-target';
import { ui } from '../output';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RpcListOptions extends ControlPlaneTargetOptions {
  json?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** 单元格长度上限：摘要保持一屏可读，完整 schema 走 --json。 */
const CELL_MAX = 56;

function cap(text: string, max = CELL_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * schema → 一行摘要：顶层属性名，必填标 `*`、可选标 `?`。
 * 无属性（`{type:'object'}` 等）→ `(none)`；非对象 schema → 其 type。
 * 嵌套结构不展开（发现用途只需要「要传哪些键」；细节在 --json）。
 */
export function schemaSummary(schema: unknown): string {
  if (!isRecord(schema)) return '-';
  const props = isRecord(schema.properties) ? schema.properties : undefined;
  if (props === undefined || Object.keys(props).length === 0) {
    const type = pickString(schema, 'type');
    return type === undefined || type === 'object' ? '(none)' : type;
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : [],
  );
  const summary = Object.keys(props)
    .map((name) => `${name}${required.has(name) ? '*' : '?'}`)
    .join(', ');
  return cap(summary);
}

interface MethodRow {
  name: string;
  permission: string;
  params: string;
  result: string;
}

function methodRows(methods: Array<Record<string, unknown>>): MethodRow[] {
  const rows: MethodRow[] = [];
  for (const method of methods) {
    const name = pickString(method, 'name');
    if (name === undefined) continue;
    rows.push({
      name,
      permission: pickString(method, 'permission') ?? '?',
      params: schemaSummary(method.params_schema),
      result: schemaSummary(method.result_schema),
    });
  }
  // 人类面按名字排序（稳定、可二分查找）；--json 保留 manifest 注册顺序。
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

/** 对齐表格（数据行英文；列宽按内容自适应，摘要列已截断）。 */
function renderTable(rows: MethodRow[]): string[] {
  const header = ['METHOD', 'PERM', 'PARAMS (*=required)', 'RESULT'];
  const widths = [
    Math.max(header[0]?.length ?? 0, ...rows.map((row) => row.name.length)),
    Math.max(header[1]?.length ?? 0, ...rows.map((row) => row.permission.length)),
    Math.max(header[2]?.length ?? 0, ...rows.map((row) => row.params.length)),
  ];
  const line = (cells: string[]): string =>
    `  ${cells
      .map((cell, index) => (index < widths.length ? cell.padEnd(widths[index] ?? 0) : cell))
      .join('  ')}`;
  return [
    ui.dim(line(header)),
    ...rows.map((row) => line([row.name, row.permission, row.params, row.result])),
  ];
}

function targetLines(target: ControlPlaneTarget, version: string): string[] {
  const lines = [
    ui.title(t('rpc.title')),
    ui.rule(48),
    ui.kv(t('agents.source'), target.baseUrl, 10),
  ];
  if (target.instance !== undefined) lines.push(ui.kv(t('agents.instance'), target.instance, 10));
  if (target.nodeId !== undefined) lines.push(ui.kv(t('rpc.node'), target.nodeId, 10));
  lines.push(ui.kv(t('rpc.version'), version, 10));
  return lines;
}

/** `vessel rpc list`：人类输出走海洋绿样式，`--json` 纯 JSON（无 ANSI）。 */
export async function rpcListCommand(options: RpcListOptions = {}): Promise<CommandResult> {
  const json = options.json === true;
  const resolved = await resolveControlPlaneTarget(options);
  if (!resolved.ok) return { exitCode: 1, stdout: '', stderr: resolved.error };
  const target = resolved.target;

  let result: unknown;
  try {
    result = await target.request('capabilities.list', {});
  } catch (error) {
    if (
      error instanceof RpcClientError &&
      (error.code === 'not_found' || error.code === 'not_supported')
    ) {
      return { exitCode: 1, stdout: '', stderr: t('rpc.unavailable') };
    }
    return {
      exitCode: 1,
      stdout: '',
      stderr:
        error instanceof RpcClientError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    await target.close().catch(() => undefined); // benign: 探针客户端关闭，失败不掩盖结果。
  }

  const manifest = isRecord(result) ? result : {};
  const methods = recordArray(manifest.methods);
  const tools = recordArray(manifest.tools);
  const plugins = recordArray(manifest.plugins);
  const version = pickString(manifest, 'version') ?? '0.0.0';

  if (json) {
    // 完整 manifest 原样透传（schema 不截断）+ 目标元信息；绝不带 token。
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          target: {
            kind: target.kind,
            base_url: target.baseUrl,
            ...(target.instance !== undefined ? { instance: target.instance } : {}),
            ...(target.nodeId !== undefined ? { node_id: target.nodeId } : {}),
          },
          version,
          ...(pickNumber(manifest, 'config_schema_version') !== undefined
            ? { config_schema_version: pickNumber(manifest, 'config_schema_version') }
            : {}),
          methods,
          tools,
          plugins,
        },
        null,
        2,
      ),
      stderr: '',
    };
  }

  const lines = targetLines(target, version);
  const rows = methodRows(methods);
  lines.push('', ui.section(`${t('rpc.methods')} (${rows.length})`));
  if (rows.length === 0) lines.push(`  ${ui.dim(t('rpc.empty'))}`);
  else lines.push(...renderTable(rows));

  const toolNames = tools
    .map((tool) => pickString(tool, 'name'))
    .filter((name): name is string => name !== undefined);
  lines.push('', ui.section(`${t('rpc.tools')} (${toolNames.length})`));
  lines.push(`  ${ui.dim(cap(toolNames.join(', '), 200) || '-')}`);

  lines.push('', ui.section(`${t('rpc.plugins')} (${plugins.length})`));
  if (plugins.length === 0) lines.push(`  ${ui.dim('-')}`);
  for (const plugin of plugins) {
    const name = pickString(plugin, 'name') ?? '?';
    lines.push(`  ${name} ${plugin.enabled === true ? ui.ok('enabled') : ui.dim('disabled')}`);
  }
  lines.push('', ui.dim(t('rpc.jsonHint')));
  return { exitCode: 0, stdout: lines.join('\n'), stderr: '' };
}
