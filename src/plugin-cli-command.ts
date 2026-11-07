/**
 * 插件 CLI 命名空间：`vessel <pluginId> <command...> [--option value]`（0.48 M2）。
 *
 * 在 `parseArgs` 之前预解析：首个 token 是已发现的 child 插件、且不是内置命令时，
 * 由本模块匹配 `contributes.cli[].path`、解析 / 校验 args，并经控制面调用
 * `plugin.<id>.<handler>`（CONTRACT-0.48 §4）。
 *
 * 约束：
 * - 内置命令优先；插件 id 不得占用内置命令名（manifest 复检带 `reservedCliNames`）；
 * - `handler` 必须是 manifest `contributes.rpc` 声明的裸名；
 * - 只支持 JSON Schema 子集；未知 key / 类型错误 / 缺必填 → exit 2；
 * - 要求 gateway 已在运行；不可用时 stderr 输出 `gateway_unavailable`
 *   并提示 `vessel gateway start`；
 * - 不 shell 执行；stdout 只放结果（截断），诊断与审计走 stderr；
 * - `<plugin> --help` 由宿主渲染，不需要 gateway。
 *
 * Exit codes：0 成功；1 运行期失败（含 `gateway_unavailable`）；2 用法 / args 非法。
 *
 * @module vessel/plugin-cli-command
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type ConfigLoadResult,
  DEFAULT_TENANT_ID,
  loadConfig,
  type PluginExposeConfig,
} from '../packages/config/src/index';
import { isCliCommandExposed } from '../packages/serve/src/index';
import { builtinCommandTokens } from './completion-spec';
import {
  type ResolveControlPlaneTargetResult,
  resolveControlPlaneTarget,
} from './control-plane-target';
import { createCliLogger } from './logging';
import {
  defaultPluginRoots,
  type PluginDescriptor,
  PluginLoader,
  type PluginRoot,
} from './plugin-loader';
import {
  type PluginCliArgsSchema,
  type PluginCliContribution,
  type PluginManifest,
  validatePluginManifest,
} from './plugin-manifest';
import { ui } from './ui-style';

/** stdout 结果上限（字节）；超出后截断并附提示 */
export const PLUGIN_CLI_MAX_STDOUT_BYTES = 64 * 1024;
/** stderr 单条错误上限（字节） */
export const PLUGIN_CLI_MAX_STDERR_BYTES = 8 * 1024;

export interface PluginCliCommandResult {
  /** false = 不是插件命令；调用方继续 `parseArgs` */
  handled: boolean;
  exitCode: number;
}

export interface PluginCliCommandOptions {
  env?: Record<string, string | undefined>;
  /** 探针注入：覆盖插件扫描根（不碰用户目录） */
  roots?: PluginRoot[];
  /** 探针注入：替换控制面解析（不触碰真实 gateway） */
  resolveTarget?: () => Promise<ResolveControlPlaneTargetResult>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** 探针注入：替换配置加载（外部插件 `expose.cli` 过滤；缺省 `loadConfig`）。 */
  loadConfig?: () => Promise<ConfigLoadResult>;
}

interface PluginCliEntry {
  descriptor: PluginDescriptor;
  manifest: PluginManifest;
  commands: PluginCliContribution[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 与 `vessel plugin` 命令一致：`VESSEL_PLUGINS_DIR` 替换默认用户插件根 */
function pluginCliRoots(env: Record<string, string | undefined>): PluginRoot[] {
  const roots = defaultPluginRoots();
  const userDir = env.VESSEL_PLUGINS_DIR;
  if (typeof userDir !== 'string' || userDir.trim() === '') return roots;
  const index = roots.findIndex((root) => root.source === 'user');
  if (index < 0) return roots;
  const resolved = path.resolve(userDir);
  return roots.map((root, current) => (current === index ? { ...root, dir: resolved } : root));
}

/** 扫描插件根，只保留声明了 `contributes.cli` 的 child 插件 */
function discoverPluginCli(
  env: Record<string, string | undefined>,
  roots?: PluginRoot[],
): Map<string, PluginCliEntry> {
  const loader = new PluginLoader({ roots: roots ?? pluginCliRoots(env) });
  const entries = new Map<string, PluginCliEntry>();
  for (const descriptor of loader.list()) {
    if (descriptor.mode !== 'child' || descriptor.manifest === undefined) continue;
    const commands = descriptor.manifest.contributes?.cli;
    if (commands === undefined || commands.length === 0) continue;
    if (!entries.has(descriptor.manifest.id)) {
      entries.set(descriptor.manifest.id, {
        descriptor,
        manifest: descriptor.manifest,
        commands,
      });
    }
  }
  return entries;
}

/**
 * 宿主保留名复检：loader 只做结构校验，这里补上 `reservedCliNames`
 * （插件 id 不得是内置命令名），并确认 `path[0] === plugin.id`。
 */
function revalidateEntry(
  entry: PluginCliEntry,
  reserved: ReadonlySet<string>,
): { ok: true; manifest: PluginManifest } | { ok: false; code: string; error: string } {
  let raw: unknown;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(entry.descriptor.dir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    raw = pkg.vessel;
  } catch (error) {
    return {
      ok: false,
      code: 'plugin_manifest_invalid',
      error: `cannot read manifest: ${errorMessage(error)}`,
    };
  }
  const result = validatePluginManifest(raw, {
    baseDir: entry.descriptor.dir,
    reservedCliNames: reserved,
    external: entry.descriptor.source !== 'repo',
  });
  if (!result.ok) return { ok: false, code: result.error.code, error: result.error.message };
  return { ok: true, manifest: result.manifest };
}

/**
 * 0.48 M4：外部插件的 CLI 授权。config 加载 / 校验失败 → undefined（fail-closed，
 * 该外部插件视为未命中；内置命令不受影响）。
 */
async function readPluginCliExpose(
  pluginId: string,
  options: PluginCliCommandOptions,
): Promise<{ expose?: PluginExposeConfig; tenantId: string } | undefined> {
  try {
    const loaded = await (options.loadConfig ?? loadConfig)();
    if (loaded.validation.errors.length > 0) return undefined;
    const config = loaded.config.plugins?.find((plugin) => plugin.name === pluginId);
    return {
      ...(config?.expose !== undefined ? { expose: config.expose } : {}),
      tenantId: loaded.tenantId,
    };
  } catch {
    return undefined;
  }
}

/** 命令路径 = 首 token 之后的连续非 flag token；其余交给 args 解析 */
function splitCommandPath(argv: string[]): { tail: string[]; rest: string[] } {
  let index = 0;
  while (index < argv.length && !(argv[index] ?? '').startsWith('-')) index += 1;
  return { tail: argv.slice(0, index), rest: argv.slice(index) };
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

// ── help 渲染 ─────────────────────────────────────

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function optionLabel(name: string, schema: PluginCliArgsSchema): string {
  switch (schema.type) {
    case 'boolean':
      return `--${name}`;
    case 'string':
      return `--${name} <string>`;
    case 'number':
      return `--${name} <number>`;
    case 'integer':
      return `--${name} <integer>`;
    case 'array':
      return `--${name} <value>...`;
    case 'object':
      return `--${name} <json>`;
    default:
      return `--${name} <value>`;
  }
}

function renderOptions(schema: PluginCliArgsSchema | undefined): string[] {
  if (schema === undefined) return [];
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const rows: Array<[string, string]> = Object.entries(properties).map(
    ([name, property]): [string, string] => {
      const extras: string[] = [];
      if (required.has(name)) extras.push('required');
      if (property.default !== undefined) extras.push(`default: ${formatValue(property.default)}`);
      if (property.enum !== undefined) {
        extras.push(`one of: ${property.enum.map(formatValue).join(', ')}`);
      }
      const description = property.description ?? '';
      const suffix = extras.length > 0 ? ` (${extras.join('; ')})` : '';
      return [optionLabel(name, property), `${description}${suffix}`.trim()];
    },
  );
  rows.push(['--help, -h', 'Show this help.']);
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, description]) => `  ${label.padEnd(width)}  ${description}`.trimEnd());
}

function renderCommandHelp(command: PluginCliContribution): string {
  const lines = [`Usage: vessel ${command.path.join(' ')} [options]`];
  if (command.description !== undefined && command.description !== '') {
    lines.push('', command.description);
  }
  const options = renderOptions(command.args);
  if (options.length > 0) lines.push('', 'Options:', ...options);
  lines.push(
    '',
    'Exit codes: 0 success, 1 runtime error (includes gateway_unavailable), 2 invalid usage.',
  );
  return lines.join('\n');
}

function renderPluginHelp(pluginId: string, commands: readonly PluginCliContribution[]): string {
  const rows = commands.map(
    (command) => [command.path.join(' '), command.description ?? ''] as const,
  );
  const width = Math.max(0, ...rows.map(([commandPath]) => commandPath.length));
  return [
    `Usage: vessel ${pluginId} <command> [options]`,
    '',
    'Commands:',
    ...rows.map(([commandPath, description]) =>
      `  ${commandPath.padEnd(width)}  ${description}`.trimEnd(),
    ),
    '',
    `Run \`vessel ${pluginId} <command> --help\` for command options.`,
    'Exit codes: 0 success, 1 runtime error (includes gateway_unavailable), 2 invalid usage.',
  ].join('\n');
}

// ── args 解析 / 校验（JSON Schema 子集）─────────────

type ArgsOutcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

function labelFor(pathName: string): string {
  if (pathName === '') return 'args';
  return pathName.includes('.') ? pathName : `--${pathName}`;
}

function coerceFromText(
  name: string,
  schema: PluginCliArgsSchema,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (schema.type) {
    case 'number': {
      const value = raw.trim() === '' ? Number.NaN : Number(raw);
      if (!Number.isFinite(value)) return { ok: false, error: `--${name} expects a number` };
      return { ok: true, value };
    }
    case 'integer': {
      const value = raw.trim() === '' ? Number.NaN : Number(raw);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, error: `--${name} expects an integer` };
      }
      return { ok: true, value };
    }
    case 'boolean': {
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, error: `--${name} expects true or false` };
    }
    case 'object': {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return { ok: false, error: `--${name} expects a JSON object` };
      }
      if (!isRecord(value)) return { ok: false, error: `--${name} expects a JSON object` };
      return { ok: true, value };
    }
    case 'array': {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return { ok: false, error: `--${name} expects a JSON array or repeated values` };
      }
      if (!Array.isArray(value)) {
        return { ok: false, error: `--${name} expects a JSON array or repeated values` };
      }
      return { ok: true, value };
    }
    case 'string':
      return { ok: true, value: raw };
    default: {
      // 无 type：枚举值按字面量匹配（`--level 2` 命中 number 枚举）
      if (schema.enum !== undefined) {
        const match = schema.enum.find((entry) => String(entry) === raw);
        if (match !== undefined) return { ok: true, value: match };
      }
      return { ok: true, value: raw };
    }
  }
}

/** 单次 flag 的数组值：可重复 flag 累加，也接受一次 JSON 数组 */
function coerceArray(
  name: string,
  schema: PluginCliArgsSchema,
  raw: string,
): { ok: true; value: unknown[] } | { ok: false; error: string } {
  if (raw.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: `--${name} expects a JSON array or repeated values` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: `--${name} expects a JSON array or repeated values` };
    }
    return { ok: true, value: parsed };
  }
  if (schema.items === undefined) return { ok: true, value: [raw] };
  const item = coerceFromText(name, schema.items, raw);
  if (!item.ok) return item;
  return { ok: true, value: [item.value] };
}

function samePrimitive(left: unknown, right: unknown): boolean {
  return left === right;
}

/** 递归校验 JSON Schema 子集；返回第一条错误（null = 通过） */
function validateArgsValue(
  schema: PluginCliArgsSchema,
  value: unknown,
  pathName: string,
  depth = 0,
): string | null {
  if (depth > 8) return `${labelFor(pathName)} is nested too deeply`;
  const isObjectShape =
    schema.type === 'object' ||
    (schema.type === undefined &&
      (schema.properties !== undefined ||
        schema.required !== undefined ||
        schema.additionalProperties !== undefined));

  if (isObjectShape) {
    if (!isRecord(value)) return `${labelFor(pathName)} must be an object`;
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) {
        return pathName === ''
          ? `--${name} is required`
          : `${labelFor(pathName)}.${name} is required`;
      }
    }
    const properties = schema.properties ?? {};
    for (const [name, entry] of Object.entries(value)) {
      const property = properties[name];
      const childPath = pathName === '' ? name : `${pathName}.${name}`;
      if (property === undefined) {
        if (schema.additionalProperties === true) continue;
        return pathName === '' ? `Unknown option: --${name}` : `Unknown key: ${childPath}`;
      }
      const violation = validateArgsValue(property, entry, childPath, depth + 1);
      if (violation !== null) return violation;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${labelFor(pathName)} must be an array`;
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return `${labelFor(pathName)} needs at least ${schema.minItems} item(s)`;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return `${labelFor(pathName)} allows at most ${schema.maxItems} item(s)`;
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const violation = validateArgsValue(
          schema.items,
          value[index],
          `${pathName || 'args'}[${index}]`,
          depth + 1,
        );
        if (violation !== null) return violation;
      }
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') return `${labelFor(pathName)} must be a string`;
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return `${labelFor(pathName)} is shorter than ${schema.minLength} characters`;
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return `${labelFor(pathName)} is longer than ${schema.maxLength} characters`;
    }
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${labelFor(pathName)} must be a number`;
    }
  } else if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `${labelFor(pathName)} must be an integer`;
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return `${labelFor(pathName)} must be a boolean`;
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => samePrimitive(entry, value))) {
    return `${labelFor(pathName)} must be one of: ${schema.enum.map(formatValue).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return `${labelFor(pathName)} must be >= ${schema.minimum}`;
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return `${labelFor(pathName)} must be <= ${schema.maximum}`;
    }
  }
  return null;
}

function parseCliArgs(schema: PluginCliArgsSchema | undefined, argv: string[]): ArgsOutcome {
  const root: PluginCliArgsSchema = schema ?? {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };
  if (root.type !== undefined && root.type !== 'object') {
    return { ok: false, error: 'command args schema must have type "object"' };
  }
  const properties = root.properties ?? {};
  const value: Record<string, unknown> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    if (!token.startsWith('--')) return { ok: false, error: `Unexpected argument: ${token}` };
    const equals = token.indexOf('=');
    const name = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    if (name === '') return { ok: false, error: `Invalid option: ${token}` };

    const property = properties[name];
    if (property === undefined) {
      if (root.additionalProperties !== true) {
        return { ok: false, error: `Unknown option: --${name}` };
      }
      if (equals >= 0) {
        value[name] = token.slice(equals + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `Missing value for --${name}` };
      }
      value[name] = next;
      index += 1;
      continue;
    }

    if (property.type === 'boolean') {
      if (equals >= 0) {
        const raw = token.slice(equals + 1);
        if (raw !== 'true' && raw !== 'false') {
          return { ok: false, error: `--${name} expects true or false` };
        }
        value[name] = raw === 'true';
      } else {
        value[name] = true;
      }
      continue;
    }

    let raw: string;
    if (equals >= 0) {
      raw = token.slice(equals + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `Missing value for --${name}` };
      }
      raw = next;
      index += 1;
    }

    if (property.type === 'array') {
      const parsed = coerceArray(name, property, raw);
      if (!parsed.ok) return parsed;
      const existing = value[name];
      value[name] = Array.isArray(existing) ? [...existing, ...parsed.value] : parsed.value;
      continue;
    }

    const coerced = coerceFromText(name, property, raw);
    if (!coerced.ok) return coerced;
    value[name] = coerced.value;
  }

  for (const [name, property] of Object.entries(properties)) {
    if (value[name] === undefined && property.default !== undefined) {
      value[name] = property.default;
    }
  }

  const violation = validateArgsValue({ ...root, type: 'object' }, value, '');
  if (violation !== null) return { ok: false, error: violation };
  return { ok: true, value };
}

// ── 输出 / 审计 ───────────────────────────────────

function truncate(text: string, maxBytes: number): string {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  let out = text;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return `${out}\n… (truncated: ${total} bytes, limit ${maxBytes})`;
}

function renderResult(result: unknown): string {
  if (result === undefined || result === null) return '';
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

/** 审计：结构化 `plugin.cli.invoke` 只进 stderr 日志（debug 级），stdout 留给结果 */
function audit(fields: Record<string, unknown>): void {
  try {
    createCliLogger().debug('plugin.cli.invoke', fields);
  } catch {
    // 审计不得改变命令语义
  }
}

// ── 入口 ─────────────────────────────────────────

/**
 * 预解析 `vessel <plugin> ...`。
 *
 * 未命中插件命名空间时返回 `{ handled: false }`，调用方继续走 `parseArgs`；
 * 命中后负责打印输出并以 `exitCode` 结束进程。
 */
export async function runPluginCliCommand(
  argv: string[],
  options: PluginCliCommandOptions = {},
): Promise<PluginCliCommandResult> {
  const env = options.env ?? process.env;
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeErr = options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));

  const first = argv[0];
  if (first === undefined || first.startsWith('-')) return { handled: false, exitCode: 0 };

  const reserved = new Set(builtinCommandTokens());
  if (reserved.has(first)) return { handled: false, exitCode: 0 };

  const entries = discoverPluginCli(env, options.roots);
  const entry = entries.get(first);
  if (entry === undefined) return { handled: false, exitCode: 0 };

  const revalidated = revalidateEntry(entry, reserved);
  if (!revalidated.ok) {
    writeErr(ui.err(`${revalidated.code}: ${revalidated.error}`));
    return { handled: true, exitCode: 1 };
  }
  let commands = revalidated.manifest.contributes?.cli ?? [];
  let tenantId = DEFAULT_TENANT_ID;

  // 0.48 M4：builtin 直接允许；外部插件懒加载 config，只保留 `expose.cli`。
  if (entry.descriptor.source !== 'repo') {
    const loaded = await readPluginCliExpose(entry.manifest.id, options);
    if (loaded === undefined) return { handled: false, exitCode: 0 };
    tenantId = loaded.tenantId;
    const allowed = new Set(loaded.expose?.cli ?? []);
    const declared = new Set(commands.map((command) => command.path.join('.')));
    for (const id of allowed) {
      if (!declared.has(id)) {
        try {
          createCliLogger().warn('plugin.expose.unknown_id', {
            plugin: entry.manifest.id,
            surface: 'cli',
            id,
          });
        } catch {
          // 告警不得改变命令语义
        }
      }
    }
    // 授权谓词只有 expose.ts 一份；CLI / catalog 不允许内联复制。
    commands = commands.filter((command) =>
      isCliCommandExposed(loaded.expose, command.path.join('.'), false),
    );
    // 没有生效的外部命令 → 按未命中回落 `parseArgs`，不暴露插件存在性。
    if (commands.length === 0) return { handled: false, exitCode: 0 };
  }

  const { tail, rest } = splitCommandPath(argv.slice(1));
  const wantsHelp = rest.includes('--help') || rest.includes('-h');
  const command = commands.find((candidate) => samePath(candidate.path.slice(1), tail));

  if (wantsHelp) {
    if (command !== undefined) {
      writeOut(renderCommandHelp(command));
    } else if (tail.length === 0) {
      if (commands.length === 1 && commands[0] !== undefined) {
        writeOut(renderCommandHelp(commands[0]));
      } else {
        writeOut(renderPluginHelp(first, commands));
      }
    } else {
      writeErr(ui.err(`Unknown command: vessel ${[first, ...tail].join(' ')}`));
      writeErr(renderPluginHelp(first, commands));
      return { handled: true, exitCode: 2 };
    }
    return { handled: true, exitCode: 0 };
  }

  if (command === undefined) {
    writeErr(ui.err(`Unknown command: vessel ${[first, ...tail].join(' ')}`));
    writeErr(renderPluginHelp(first, commands));
    return { handled: true, exitCode: 2 };
  }

  const parsed = parseCliArgs(command.args, rest);
  if (!parsed.ok) {
    writeErr(ui.err(`Invalid arguments: ${parsed.error}`));
    writeErr(`Run \`vessel ${command.path.join(' ')} --help\` for usage.`);
    return { handled: true, exitCode: 2 };
  }

  const rpcNames = new Set((entry.manifest.contributes?.rpc ?? []).map((rpc) => rpc.name));
  if (!rpcNames.has(command.handler)) {
    writeErr(
      ui.err(
        `plugin_manifest_invalid: handler "${command.handler}" is not declared in contributes.rpc`,
      ),
    );
    return { handled: true, exitCode: 1 };
  }

  const invokeStartedAt = Date.now();
  let resolved: ResolveControlPlaneTargetResult;
  try {
    resolved =
      options.resolveTarget !== undefined
        ? await options.resolveTarget()
        : await resolveControlPlaneTarget({ env });
  } catch (error) {
    resolved = { ok: false, code: 'no_gateway', error: errorMessage(error) };
  }
  if (!resolved.ok) {
    writeErr(ui.err(`gateway_unavailable: ${resolved.error}`));
    writeErr('Hint: start one with `vessel gateway start`.');
    audit({
      plugin: entry.manifest.id,
      command: command.path.join('.'),
      outcome: 'gateway_unavailable',
      durationMs: Date.now() - invokeStartedAt,
      tenant: tenantId,
    });
    return { handled: true, exitCode: 1 };
  }

  const method = `plugin.${entry.manifest.id}.${command.handler}`;
  try {
    const result = await resolved.target.request(method, parsed.value);
    const text = truncate(renderResult(result), PLUGIN_CLI_MAX_STDOUT_BYTES);
    if (text !== '') writeOut(text);
    audit({
      plugin: entry.manifest.id,
      command: command.path.join('.'),
      outcome: 'ok',
      durationMs: Date.now() - invokeStartedAt,
      tenant: tenantId,
    });
    return { handled: true, exitCode: 0 };
  } catch (error) {
    const message = truncate(errorMessage(error), PLUGIN_CLI_MAX_STDERR_BYTES);
    writeErr(ui.err(`plugin_cli_failed: ${message}`));
    audit({
      plugin: entry.manifest.id,
      command: command.path.join('.'),
      outcome: 'error',
      durationMs: Date.now() - invokeStartedAt,
      tenant: tenantId,
    });
    return { handled: true, exitCode: 1 };
  } finally {
    try {
      await resolved.target.close();
    } catch {
      // 关闭失败不影响已产出的结果
    }
  }
}
