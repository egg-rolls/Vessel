/**
 * Plugin manifest — `package.json.vessel`（CONTRACT-0.43 §1）。
 *
 * 一个包同时是「能力插件」（in-process `Plugin`）还是「体验插件」（child process）
 * 由清单决定：带 `vessel.entry` + `vessel.contributes` 的包是 child 模式，其余仍是
 * 现有 in-process 插件。两种模式共用同一清单 / 发现 / 安装生命周期。
 *
 * 校验失败一律 fail-closed（不加载代码），错误码见 {@link PluginErrorCode}。
 *
 * 版本范围只支持 `>=x` / `>x.y` / `<=x.y.z` 这类比较符（端点缺位补 0），
 * 空格分隔为 AND、`||` 分隔为 OR；`x` 单独出现等同 `=x.0.0`。
 * 不支持 `^` / `~` / 预发布排序（`1.0.0-beta`）——这些会报
 * `plugin_manifest_invalid`。
 *
 * @module vessel/plugin-manifest
 */

import * as path from 'node:path';
import { readPackageVersion } from './version';

/** 清单 id：`[a-z0-9][a-z0-9-]{1,63}` */
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** `contributes.rpc[].name`：宿主注册为 `plugin.<id>.<name>`，不允许带点 */
export const PLUGIN_RPC_NAME_RE = /^[a-z][a-z0-9_-]*$/;

export type PluginSide = 'backend' | 'ui' | 'both';

/** 内置导航组（宿主固定，不可被 mod 覆盖）：core 组 + plugins 组 */
export type PluginBuiltInNav =
  | 'chat'
  | 'network'
  | 'runs'
  | 'integrations'
  | 'status'
  | 'observe'
  | 'settings'
  | 'top'
  | 'plugins';
/** 页面导航组：内置组，或该 plugin 自己的 `plugin:<pluginId>` 自定义组 */
export type PluginPageNav = PluginBuiltInNav | `plugin:${string}`;

/** 0.45 图标白名单（宿主渲染的子集） */
export const PLUGIN_ICON_NAMES = [
  'chat',
  'hub',
  'gateway',
  'nodes',
  'teams',
  'agents',
  'runs',
  'tools',
  'mcp',
  'channels',
  'plugins',
  'observe',
  'settings',
] as const;
export type PluginIconName = (typeof PLUGIN_ICON_NAMES)[number];

/** 自定义导航组；id 必须等于 `plugin:<pluginId>`，每个 plugin 最多一个 */
export interface PluginNavGroup {
  id: string;
  title: string;
  /** 宿主 i18n key；`title` 是 fallback */
  titleKey?: string;
  icon?: PluginIconName;
  order?: number;
}

/** 宿主支持的 i18n locale（导航 / 共享字符串） */
export type PluginLocale = 'en' | 'zh-CN';
/** `contributes.i18n`：locale → (key → 文案) */
export type PluginI18n = Partial<Record<PluginLocale, Record<string, string>>>;

export type PluginPanelSlot = 'run-detail' | 'session-detail' | 'nav';

export interface PluginPageContribution {
  id: string;
  title?: string;
  /** 宿主 i18n key（web 导航标签）；`title` 是 fallback */
  titleKey?: string;
  nav?: PluginPageNav;
  /** 0.45：导航图标，必须在 {@link PLUGIN_ICON_NAMES} 白名单内 */
  icon?: PluginIconName;
  order?: number;
  /** 相对 `ui.dir` 的静态入口 */
  entry: string;
}

export interface PluginCommandContribution {
  name: string;
  title?: string;
}

/** settings 只声明 JSON Schema 子集；宿主 v1 不自动渲染表单 */
export interface PluginSettingSchema {
  type?: string;
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

/** RPC 调用权限；缺省 read（E10 只开放 read / write） */
export type PluginRpcPermission = 'read' | 'write';

export interface PluginRpcContribution {
  name: string;
  description?: string;
  permission?: PluginRpcPermission;
}

export interface PluginPanelContribution {
  slot: PluginPanelSlot;
  id: string;
  /** 相对 `ui.dir` 的静态入口 */
  entry: string;
  order?: number;
}

/**
 * 输入框工具栏槽位（0.51 additive）。
 *
 * v1 只有会话 / 团队共用的 `composer` 一个槽位；插件只**声明**按钮，
 * 点击由宿主按 `id` 映射成宿主回调（插件拿不到宿主回调，无法内联执行）。
 */
export type PluginToolbarSlot = 'composer';

export interface PluginToolbarContribution {
  slot: PluginToolbarSlot;
  /** 宿主映射用的稳定 id；同一 plugin 内唯一。 */
  id: string;
  /** 按钮文字（宿主可覆盖）；必填，避免渲染无名按钮。 */
  label: string;
  /** 宿主 / 插件私有 i18n key；`label` 仍是 fallback。 */
  titleKey?: string;
  /** 白名单图标名（复用 {@link PLUGIN_ICON_NAMES}）。 */
  icon?: PluginIconName;
  order?: number;
}

/** 0.48 M1：`contributes.http[].method`（CONTRACT-0.48 §2） */
export type PluginHttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
/** 0.48 M1：HTTP 鉴权口径；缺省 `required` */
export type PluginHttpAuth = 'required' | 'none' | 'plugin';
/** 0.48 M1：HTTP 权限范围；缺省 `read` */
export type PluginHttpScope = 'read' | 'write' | 'admin';
/** 0.48 M1：`stream` 跳过 `maxResponseBytes`，只受 idle timeout 约束 */
export type PluginHttpResponseMode = 'buffered' | 'stream';
/** 0.48 M3：升级路由类型；v1 只支持 `websocket`（缺省 = 非升级路由） */
export type PluginHttpUpgrade = 'websocket';

/**
 * 0.48 M1：插件 HTTP 路由声明（CONTRACT-0.48 §2）。
 *
 * 路由由插件自己的 loopback 服务处理，因此没有 `handler`；`id` 只用于
 * 授权 / 冲突 / 审计。限额只能收紧宿主默认，实际 clamp 由宿主做。
 */
export interface PluginHttpContribution {
  id: string;
  method: PluginHttpMethod;
  /** 绝对路径；支持 `:name` 单段参数 */
  path: string;
  auth: PluginHttpAuth;
  scope: PluginHttpScope;
  responseMode: PluginHttpResponseMode;
  timeoutMs?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  /** 0.48 M3：声明为 WS 升级路由；method 必须是 GET。 */
  upgrade?: PluginHttpUpgrade;
  /** 0.48 M3：WS 应用帧 idle；只能收紧宿主默认（30s）。 */
  idleTimeoutMs?: number;
  /** 0.48 M3：WS 单帧上限；只能收紧宿主默认（1 MiB）。 */
  maxFrameBytes?: number;
  /** 0.48 M3：并发连接上限（HTTP 在途 + 打开的 WS）。 */
  maxConnections?: number;
}

/** 0.48 M2：CLI args 允许的 JSON Schema `type` 子集 */
export type PluginCliArgType = 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';

/** 0.48 M2：CLI args 的 JSON Schema 子集（CONTRACT-0.48 §4） */
export interface PluginCliArgsSchema {
  type?: PluginCliArgType;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, PluginCliArgsSchema>;
  additionalProperties?: boolean;
  items?: PluginCliArgsSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** 0.48 M2：插件 CLI 命令声明；`handler` 必须是 `contributes.rpc` 里的裸名 */
export interface PluginCliContribution {
  /** 首段必须等于 plugin id；插件不得覆盖内置命令 */
  path: string[];
  description?: string;
  args?: PluginCliArgsSchema;
  handler: string;
}

export interface PluginContributions {
  /** 0.45：自定义导航组；每个 plugin 最多一个，id 固定 `plugin:<pluginId>` */
  navGroups?: PluginNavGroup[];
  /** 0.45 E9：宿主 i18n 文案（en / zh-CN） */
  i18n?: PluginI18n;
  pages?: PluginPageContribution[];
  commands?: PluginCommandContribution[];
  settings?: Record<string, PluginSettingSchema>;
  rpc?: PluginRpcContribution[];
  events?: string[];
  panels?: PluginPanelContribution[];
  /** 0.51 additive：输入框工具栏声明（declarative，点击由宿主映射） */
  toolbar?: PluginToolbarContribution[];
  /** 0.48 M1：宿主 loopback 反代的 HTTP 路由 */
  http?: PluginHttpContribution[];
  /** 0.48 M2：经 rpc handler 执行的 CLI 命令 */
  cli?: PluginCliContribution[];
}

export interface PluginPermissions {
  fs: string[];
  net: string[];
  process: boolean;
  secrets: boolean;
  events: string[];
  rpc: string[];
}

export interface PluginDependency {
  plugins: string[];
  ordering: { after: string[]; before: string[] };
}

/** 规范化后的清单（缺省值已补齐） */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  engines: { vessel: string };
  description?: string;
  side: PluginSide;
  entry: string;
  ui?: { dir: string };
  activationEvents: string[];
  contributes?: PluginContributions;
  permissions: PluginPermissions;
  dependencies: PluginDependency;
  /** 显式允许覆盖同 id 的内置插件 */
  override?: boolean;
}

/** CONTRACT-0.43 §8 错误码（plugin_* 命名） */
export type PluginErrorCode =
  | 'plugin_manifest_invalid'
  | 'plugin_id_conflict'
  | 'plugin_version_incompatible'
  | 'plugin_dependency_missing'
  | 'plugin_cycle'
  | 'plugin_activation_failed'
  | 'plugin_timeout'
  | 'plugin_crashed'
  | 'plugin_payload_too_large'
  | 'plugin_permission_denied'
  | 'plugin_rpc_denied'
  | 'plugin_config_invalid'
  | 'plugin_event_dropped';

/** 清单解析 / 校验阶段可能产生的错误码 */
export type PluginManifestErrorCode =
  | 'plugin_manifest_invalid'
  | 'plugin_id_conflict'
  | 'plugin_version_incompatible'
  | 'plugin_dependency_missing'
  | 'plugin_cycle'
  | 'plugin_config_invalid';

export class PluginManifestValidationError extends Error {
  readonly code: PluginManifestErrorCode;

  constructor(code: PluginManifestErrorCode, message: string) {
    super(message);
    this.name = 'PluginManifestValidationError';
    this.code = code;
  }
}

export interface PluginManifestOptions {
  /** mod / 插件包目录；用于 entry / ui.dir 越界检查 */
  baseDir: string;
  /** 当前 Vessel 版本；缺省读根 package.json */
  vesselVersion?: string;
  /** 已知插件 id；提供时检查 `dependencies.plugins` 是否缺失 */
  knownPluginIds?: Iterable<string>;
  /**
   * 0.48 M4：外部插件（非 `repo` 源）。提供为 true 时，`contributes.http[].path`
   * 必须落在 `/plugins/<own-id>/<至少一个非空段>` 命名空间内（CONTRACT-0.48 §6.1）。
   * 缺省 false（内置插件沿用 M1 规则）。
   */
  external?: boolean;
  /**
   * 0.48 M1：宿主保留的 HTTP 路由。条目使用与 `contributes.http[].path` 相同的
   * 语法；末尾 `/*` 表示前缀子树（如 `/v1/*`）。提供时，形状相同的插件路由、
   * 或落在保留前缀下的插件路由校验失败。不提供时只做结构校验（assembly 后续传入）。
   */
  reservedHttpRoutes?: Iterable<string>;
  /**
   * 0.48 M2：宿主内置 CLI 命令名。提供时插件 id 不得占用这些名字
   * （`contributes.cli[].path[0]` 必须等于 plugin id，因此同时覆盖 CLI 命名空间）。
   * 不提供时只做结构校验（CLI 后续传入）。
   */
  reservedCliNames?: Iterable<string>;
}

export type PluginManifestValidation =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: PluginManifestValidationError };

function fail(code: PluginManifestErrorCode, message: string): never {
  throw new PluginManifestValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('plugin_manifest_invalid', `${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('plugin_manifest_invalid', `${field} must be a string`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('plugin_manifest_invalid', `${field} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    fail('plugin_manifest_invalid', `${field} must be an array of strings`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`));
}

// ── semver（最小实现） ──────────────────────────────────────────────────────

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
}

type ComparatorOperator = '>=' | '<=' | '>' | '<' | '=';

interface VersionComparator {
  op: ComparatorOperator;
  version: SemverParts;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;
/** 范围端点允许 `x` / `x.y` / `x.y.z`（缺位补 0，契约示例 `>=0.43 <0.45`） */
const RANGE_VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?(?:\.\d+)?)$/;

function parseSemver(value: string): SemverParts | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 范围端点解析：`0.43` → 0.43.0 */
function parseRangeVersion(value: string): SemverParts | null {
  const match = RANGE_VERSION_RE.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** 是否为支持的完整 semver（`x.y.z`） */
export function isValidSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** 解析版本范围；不支持的语法返回 null（调用方报 plugin_manifest_invalid） */
export function parseVersionRange(range: string): VersionComparator[][] | null {
  const alternatives: VersionComparator[][] = [];
  for (const alternative of range.split('||')) {
    const trimmed = alternative.trim();
    if (trimmed === '') return null;
    const comparators: VersionComparator[] = [];
    for (const token of trimmed.split(/\s+/)) {
      const match = COMPARATOR_RE.exec(token);
      if (!match) return null;
      const version = parseRangeVersion(match[2] ?? '');
      if (!version) return null;
      comparators.push({ op: (match[1] as ComparatorOperator | undefined) ?? '=', version });
    }
    alternatives.push(comparators);
  }
  return alternatives.length > 0 ? alternatives : null;
}

function satisfiesComparator(version: SemverParts, comparator: VersionComparator): boolean {
  const delta = compareSemver(version, comparator.version);
  switch (comparator.op) {
    case '>=':
      return delta >= 0;
    case '<=':
      return delta <= 0;
    case '>':
      return delta > 0;
    case '<':
      return delta < 0;
    default:
      return delta === 0;
  }
}

/** `version` 是否满足 `range`；范围语法不支持时返回 false */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version);
  const parsedRange = parseVersionRange(range);
  if (!parsedVersion || !parsedRange) return false;
  return parsedRange.some((alternative) =>
    alternative.every((comparator) => satisfiesComparator(parsedVersion, comparator)),
  );
}

// ── 路径与事件白名单 ────────────────────────────────────────────────────────

/** entry / ui.dir 必须留在包目录内 */
function isContainedPath(baseDir: string, value: string): boolean {
  if (value.trim() === '' || path.isAbsolute(value)) return false;
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, value);
  const relative = path.relative(base, resolved);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** 相对 ui.dir 的静态入口：不允许绝对路径 / `..` 越界 */
function isSafeRelativePath(value: string): boolean {
  if (value.trim() === '' || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `llm.*` 这类权限模式匹配事件名 */
function globMatches(pattern: string, value: string): boolean {
  const regexp = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`);
  return regexp.test(value);
}

// ── 权限 / 贡献点 ───────────────────────────────────────────────────────────

function readPermissions(raw: unknown): PluginPermissions {
  if (raw === undefined) {
    return { fs: [], net: [], process: false, secrets: false, events: [], rpc: [] };
  }
  if (!isRecord(raw)) fail('plugin_manifest_invalid', 'permissions must be an object');

  const fs = raw.fs === undefined ? [] : stringArray(raw.fs, 'permissions.fs');
  const net = raw.net === undefined ? [] : stringArray(raw.net, 'permissions.net');
  const events = raw.events === undefined ? [] : stringArray(raw.events, 'permissions.events');
  const rpc = raw.rpc === undefined ? [] : stringArray(raw.rpc, 'permissions.rpc');

  const process =
    raw.process === undefined ? false : readBoolean(raw.process, 'permissions.process');
  const secrets =
    raw.secrets === undefined ? false : readBoolean(raw.secrets, 'permissions.secrets');

  return { fs, net, process, secrets, events, rpc };
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail('plugin_manifest_invalid', `${field} must be a boolean`);
  return value;
}

const BUILT_IN_NAVS: ReadonlySet<string> = new Set([
  'chat',
  'network',
  'runs',
  'integrations',
  'status',
  'observe',
  'settings',
  'top',
  'plugins',
]);

function isBuiltInNav(value: unknown): value is PluginBuiltInNav {
  return typeof value === 'string' && BUILT_IN_NAVS.has(value);
}

function readIcon(value: unknown, field: string): PluginIconName | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(PLUGIN_ICON_NAMES as readonly string[]).includes(value)) {
    fail(
      'plugin_manifest_invalid',
      `${field} "${String(value)}" is not in the icon whitelist (${PLUGIN_ICON_NAMES.join(', ')})`,
    );
  }
  return value as PluginIconName;
}

/** page.nav：内置组，或该 plugin 自己的 `plugin:<pluginId>`；跨 plugin 引用非法 */
function readPageNav(value: unknown, pluginId: string, field: string): PluginPageNav {
  if (isBuiltInNav(value)) return value;
  if (typeof value === 'string' && value.startsWith('plugin:')) {
    const own = `plugin:${pluginId}`;
    if (value !== own) {
      fail(
        'plugin_manifest_invalid',
        `${field} "${value}" references another plugin's nav group (expected "${own}")`,
      );
    }
    return value as PluginPageNav;
  }
  fail('plugin_manifest_invalid', `${field} is invalid (built-in nav or "plugin:${pluginId}")`);
}

/** navGroups：每个 plugin 最多一个，id 固定 `plugin:<pluginId>`，内置 id 保留 */
function readNavGroups(value: unknown, pluginId: string): PluginNavGroup[] {
  if (!Array.isArray(value)) {
    fail('plugin_manifest_invalid', 'contributes.navGroups must be an array');
  }
  if (value.length > 1) {
    fail('plugin_manifest_invalid', 'contributes.navGroups allows at most one group per plugin');
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.navGroups[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);
    const id = requireString(item.id, `${field}.id`);
    if (isBuiltInNav(id)) {
      fail('plugin_manifest_invalid', `${field}.id "${id}" is a reserved built-in nav group`);
    }
    const own = `plugin:${pluginId}`;
    if (id !== own) {
      fail('plugin_manifest_invalid', `${field}.id must equal "${own}"`);
    }
    if (seen.has(id)) fail('plugin_manifest_invalid', `duplicate nav group id "${id}"`);
    seen.add(id);
    const title = requireString(item.title, `${field}.title`);
    const titleKey =
      item.titleKey === undefined ? undefined : requireString(item.titleKey, `${field}.titleKey`);
    const icon = readIcon(item.icon, `${field}.icon`);
    const order = optionalNumber(item.order, `${field}.order`);
    return {
      id,
      title,
      ...(titleKey !== undefined ? { titleKey } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(order !== undefined ? { order } : {}),
    };
  });
}

function readPages(value: unknown, pluginId: string): PluginPageContribution[] {
  if (!Array.isArray(value)) fail('plugin_manifest_invalid', 'contributes.pages must be an array');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.pages[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);
    const id = requireString(item.id, `${field}.id`);
    if (seen.has(id)) fail('plugin_manifest_invalid', `duplicate page id "${id}"`);
    seen.add(id);
    const entry = requireString(item.entry, `${field}.entry`);
    if (!isSafeRelativePath(entry)) {
      fail('plugin_manifest_invalid', `${field}.entry must stay inside ui.dir`);
    }
    const title = optionalString(item.title, `${field}.title`);
    const titleKey =
      item.titleKey === undefined ? undefined : requireString(item.titleKey, `${field}.titleKey`);
    const order = optionalNumber(item.order, `${field}.order`);
    const nav =
      item.nav === undefined ? undefined : readPageNav(item.nav, pluginId, `${field}.nav`);
    const icon = readIcon(item.icon, `${field}.icon`);
    return {
      id,
      ...(title !== undefined ? { title } : {}),
      ...(titleKey !== undefined ? { titleKey } : {}),
      ...(nav !== undefined ? { nav } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(order !== undefined ? { order } : {}),
      entry,
    };
  });
}

function isPanelSlot(value: unknown): value is PluginPanelSlot {
  return value === 'run-detail' || value === 'session-detail' || value === 'nav';
}

function isToolbarSlot(value: unknown): value is PluginToolbarSlot {
  return value === 'composer';
}

/**
 * `contributes.toolbar[]`（0.51 additive）：declarative 按钮声明。
 *
 * 与 panels 的区别：没有 `entry`（不挂 iframe），只声明「宿主工具栏上有一个
 * 按钮」；点击由宿主按 id 映射，宿主没有对应动作时该按钮不会渲染。
 */
function readToolbar(value: unknown): PluginToolbarContribution[] {
  if (!Array.isArray(value))
    fail('plugin_manifest_invalid', 'contributes.toolbar must be an array');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.toolbar[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);
    if (!isToolbarSlot(item.slot)) {
      fail('plugin_manifest_invalid', `${field}.slot is invalid (composer)`);
    }
    const id = requireString(item.id, `${field}.id`);
    if (seen.has(id)) fail('plugin_manifest_invalid', `duplicate toolbar id "${id}"`);
    seen.add(id);
    const label = requireString(item.label, `${field}.label`);
    const titleKey =
      item.titleKey === undefined ? undefined : requireString(item.titleKey, `${field}.titleKey`);
    const icon = readIcon(item.icon, `${field}.icon`);
    const order = optionalNumber(item.order, `${field}.order`);
    return {
      slot: item.slot,
      id,
      label,
      ...(titleKey !== undefined ? { titleKey } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(order !== undefined ? { order } : {}),
    };
  });
}

function readCommands(value: unknown): PluginCommandContribution[] {
  if (!Array.isArray(value)) {
    fail('plugin_manifest_invalid', 'contributes.commands must be an array');
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.commands[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);
    const name = requireString(item.name, `${field}.name`);
    if (seen.has(name)) fail('plugin_manifest_invalid', `duplicate command name "${name}"`);
    seen.add(name);
    const title = optionalString(item.title, `${field}.title`);
    return { name, ...(title !== undefined ? { title } : {}) };
  });
}

const I18N_LOCALES: ReadonlySet<string> = new Set(['en', 'zh-CN']);
const I18N_KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
const I18N_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const I18N_MAX_KEYS = 200;
const I18N_MAX_VALUE_LENGTH = 200;

function readI18n(value: unknown): PluginI18n {
  if (!isRecord(value)) fail('plugin_manifest_invalid', 'contributes.i18n must be an object');
  const out: PluginI18n = {};
  for (const [locale, dictionary] of Object.entries(value)) {
    if (!I18N_LOCALES.has(locale)) {
      fail(
        'plugin_manifest_invalid',
        `contributes.i18n.${locale} is not a supported locale (en | zh-CN)`,
      );
    }
    if (!isRecord(dictionary)) {
      fail('plugin_manifest_invalid', `contributes.i18n.${locale} must be an object`);
    }
    const keys = Object.keys(dictionary);
    if (keys.length > I18N_MAX_KEYS) {
      fail(
        'plugin_manifest_invalid',
        `contributes.i18n.${locale} allows at most ${I18N_MAX_KEYS} keys`,
      );
    }
    const normalized: Record<string, string> = {};
    for (const key of keys) {
      if (!I18N_KEY_RE.test(key)) {
        fail(
          'plugin_manifest_invalid',
          `contributes.i18n.${locale} key "${key}" must match ${I18N_KEY_RE.source}`,
        );
      }
      if (I18N_FORBIDDEN_KEYS.has(key)) {
        fail('plugin_manifest_invalid', `contributes.i18n.${locale} key "${key}" is reserved`);
      }
      const text = dictionary[key];
      if (typeof text !== 'string' || text.trim() === '') {
        fail(
          'plugin_manifest_invalid',
          `contributes.i18n.${locale}.${key} must be a non-empty string`,
        );
      }
      if (text.length > I18N_MAX_VALUE_LENGTH) {
        fail(
          'plugin_manifest_invalid',
          `contributes.i18n.${locale}.${key} must be at most ${I18N_MAX_VALUE_LENGTH} chars`,
        );
      }
      normalized[key] = text;
    }
    out[locale as PluginLocale] = normalized;
  }
  return out;
}

function readSettings(value: unknown): Record<string, PluginSettingSchema> {
  if (!isRecord(value)) fail('plugin_manifest_invalid', 'contributes.settings must be an object');
  const out: Record<string, PluginSettingSchema> = {};
  for (const [key, schema] of Object.entries(value)) {
    if (key.trim() === '') fail('plugin_manifest_invalid', 'settings keys must be non-empty');
    if (!isRecord(schema)) {
      fail('plugin_manifest_invalid', `contributes.settings.${key} must be an object`);
    }
    if (schema.type !== undefined && typeof schema.type !== 'string') {
      fail('plugin_manifest_invalid', `contributes.settings.${key}.type must be a string`);
    }
    if (schema.description !== undefined && typeof schema.description !== 'string') {
      fail('plugin_manifest_invalid', `contributes.settings.${key}.description must be a string`);
    }
    out[key] = { ...schema };
  }
  return out;
}

function readRpc(value: unknown): PluginRpcContribution[] {
  if (!Array.isArray(value)) fail('plugin_manifest_invalid', 'contributes.rpc must be an array');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.rpc[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);
    const name = requireString(item.name, `${field}.name`);
    if (!PLUGIN_RPC_NAME_RE.test(name)) {
      fail(
        'plugin_manifest_invalid',
        `${field}.name "${name}" must match ${PLUGIN_RPC_NAME_RE.source}`,
      );
    }
    if (seen.has(name)) fail('plugin_manifest_invalid', `duplicate rpc name "${name}"`);
    seen.add(name);
    const description = optionalString(item.description, `${field}.description`);
    let permission: PluginRpcPermission = 'read';
    if (item.permission !== undefined) {
      if (item.permission !== 'read' && item.permission !== 'write') {
        fail('plugin_manifest_invalid', `${field}.permission must be read | write`);
      }
      permission = item.permission;
    }
    return {
      name,
      ...(description !== undefined ? { description } : {}),
      permission,
    };
  });
}

function readPanels(value: unknown): PluginPanelContribution[] {
  if (!Array.isArray(value)) fail('plugin_manifest_invalid', 'contributes.panels must be an array');
  return value.map((item, index) => {
    const field = `contributes.panels[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);
    if (!isPanelSlot(item.slot)) fail('plugin_manifest_invalid', `${field}.slot is invalid`);
    const id = requireString(item.id, `${field}.id`);
    const entry = requireString(item.entry, `${field}.entry`);
    if (!isSafeRelativePath(entry)) {
      fail('plugin_manifest_invalid', `${field}.entry must stay inside ui.dir`);
    }
    const order = optionalNumber(item.order, `${field}.order`);
    return { slot: item.slot, id, entry, ...(order !== undefined ? { order } : {}) };
  });
}

// ── 0.48 扩展面：HTTP 路由 / CLI 命令 ─────────────────────────────────────

const PLUGIN_HTTP_METHODS: readonly PluginHttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
];
const PLUGIN_HTTP_AUTHS: readonly PluginHttpAuth[] = ['required', 'none', 'plugin'];
const PLUGIN_HTTP_SCOPES: readonly PluginHttpScope[] = ['read', 'write', 'admin'];
const PLUGIN_HTTP_RESPONSE_MODES: readonly PluginHttpResponseMode[] = ['buffered', 'stream'];
const PLUGIN_HTTP_UPGRADES: readonly PluginHttpUpgrade[] = ['websocket'];

/** 静态段允许字符（DESIGN-0.48 §3.1）：`[A-Za-z0-9._~/-]`，参数段另支持 `:` */
const HTTP_STATIC_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/;
/** `:name` 单段参数；name 以字母开头 */
const HTTP_PARAM_SEGMENT_RE = /^:[A-Za-z][A-Za-z0-9_]*$/;
const CLI_PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const CLI_ARG_TYPES: readonly PluginCliArgType[] = [
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
];
/** 只接受这些 JSON Schema 关键字；其余一律视为越界 */
const CLI_ARG_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'type',
  'description',
  'default',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);
const CLI_ARG_RESERVED_NAMES: ReadonlySet<string> = new Set(['help', 'version', '__proto__']);
const CLI_ARG_MAX_DEPTH = 8;

function readEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail('plugin_manifest_invalid', `${field} must be one of: ${allowed.join(' | ')}`);
  }
  return value as T;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('plugin_manifest_invalid', `${field} must be a finite number`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('plugin_manifest_invalid', `${field} must be a non-negative integer`);
  }
  return value;
}

/** 限额字段只校验正整数；能否放宽由宿主 clamp（CONTRACT-0.48 §2） */
function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail('plugin_manifest_invalid', `${field} must be a positive integer`);
  }
  return value;
}

/**
 * 解析插件 / 保留路由路径，返回参数名归一化后的形状（参数段 → `:`）。
 *
 * 规则：绝对路径；禁止空段、`.` / `..`、query / fragment、通配 `*`；
 * 参数必须是 `:name` 单段且同一路由内不重复。静态段与参数段形状不同，
 * 因此 `/hub/directory` 与 `/hub/:id` 不冲突（静态段优先的注册语义由宿主实现）。
 */
function parseHttpRoutePath(value: string, field: string): string {
  if (!value.startsWith('/')) {
    fail('plugin_manifest_invalid', `${field} must be an absolute path starting with "/"`);
  }
  if (value.includes('?') || value.includes('#')) {
    fail('plugin_manifest_invalid', `${field} must not contain a query or fragment`);
  }
  if (value.includes('*')) {
    fail('plugin_manifest_invalid', `${field} must not contain wildcards`);
  }
  if (value === '/') return '/';
  if (value.endsWith('/')) {
    fail('plugin_manifest_invalid', `${field} must not contain an empty segment`);
  }

  const params = new Set<string>();
  const shape: string[] = [];
  const segments = value.slice(1).split('/');
  for (const segment of segments) {
    if (segment === '') {
      fail('plugin_manifest_invalid', `${field} must not contain an empty segment`);
    }
    if (segment === '.' || segment === '..') {
      fail('plugin_manifest_invalid', `${field} must not contain "." or ".." segments`);
    }
    if (segment.startsWith(':')) {
      if (!HTTP_PARAM_SEGMENT_RE.test(segment)) {
        fail(
          'plugin_manifest_invalid',
          `${field} segment "${segment}" must be a ":name" single-segment parameter`,
        );
      }
      const name = segment.slice(1);
      if (params.has(name)) {
        fail('plugin_manifest_invalid', `${field} repeats parameter ":${name}"`);
      }
      params.add(name);
      shape.push(':');
      continue;
    }
    if (!HTTP_STATIC_SEGMENT_RE.test(segment)) {
      fail(
        'plugin_manifest_invalid',
        `${field} segment "${segment}" must match ${HTTP_STATIC_SEGMENT_RE.source}`,
      );
    }
    shape.push(segment);
  }
  return `/${shape.join('/')}`;
}

interface ReservedHttpRoutes {
  /** 精确形状 */
  exact: ReadonlySet<string>;
  /** 前缀子树基底（不含末尾 `/`） */
  prefixes: readonly string[];
}

/** 保留路由：精确条目 + `/*` 后缀前缀条目；从宿主路由表派生，不手写 */
function readReservedHttpRoutes(
  value: Iterable<string> | undefined,
): ReservedHttpRoutes | undefined {
  if (value === undefined) return undefined;
  const exact = new Set<string>();
  const prefixes: string[] = [];
  let index = 0;
  for (const route of value) {
    if (route.endsWith('/*')) {
      const base = route.slice(0, -2);
      prefixes.push(base === '' ? '/' : parseHttpRoutePath(base, `reservedHttpRoutes[${index}]`));
    } else {
      exact.add(parseHttpRoutePath(route, `reservedHttpRoutes[${index}]`));
    }
    index += 1;
  }
  return { exact, prefixes };
}

function isReservedHttpRoute(shape: string, reserved: ReservedHttpRoutes): boolean {
  if (reserved.exact.has(shape)) return true;
  return reserved.prefixes.some(
    (prefix) => prefix === '/' || shape === prefix || shape.startsWith(`${prefix}/`),
  );
}

function readHttp(
  value: unknown,
  reserved: ReservedHttpRoutes | undefined,
  pluginId: string,
  external: boolean,
): PluginHttpContribution[] {
  if (!Array.isArray(value)) fail('plugin_manifest_invalid', 'contributes.http must be an array');
  const seenIds = new Set<string>();
  const seenRoutes = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.http[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);

    const id = requireString(item.id, `${field}.id`);
    if (seenIds.has(id)) fail('plugin_manifest_invalid', `duplicate http id "${id}"`);
    seenIds.add(id);

    const method = readEnum(item.method, PLUGIN_HTTP_METHODS, `${field}.method`);
    const routePath = requireString(item.path, `${field}.path`);
    const shape = parseHttpRoutePath(routePath, `${field}.path`);
    const routeKey = `${method} ${shape}`;
    if (seenRoutes.has(routeKey)) {
      fail(
        'plugin_manifest_invalid',
        `${field} duplicates another route (same method and path shape: ${routeKey})`,
      );
    }
    seenRoutes.add(routeKey);
    // 0.48 M4：外部插件只能占用自己的 `/plugins/<own-id>/` 命名空间。
    const ownPrefix = `/plugins/${pluginId}/`;
    const ownNamespace = external && shape.startsWith(ownPrefix) && shape.length > ownPrefix.length;
    if (external && !ownNamespace) {
      fail(
        'plugin_manifest_invalid',
        `${field}.path "${routePath}" must match /plugins/${pluginId}/<segment>`,
      );
    }
    if (reserved !== undefined && !ownNamespace && isReservedHttpRoute(shape, reserved)) {
      fail(
        'plugin_manifest_invalid',
        `${field}.path "${routePath}" conflicts with a reserved host route`,
      );
    }

    const auth =
      item.auth === undefined
        ? 'required'
        : readEnum(item.auth, PLUGIN_HTTP_AUTHS, `${field}.auth`);
    const scope =
      item.scope === undefined
        ? 'read'
        : readEnum(item.scope, PLUGIN_HTTP_SCOPES, `${field}.scope`);
    const responseModeRaw =
      item.responseMode === undefined
        ? undefined
        : readEnum(item.responseMode, PLUGIN_HTTP_RESPONSE_MODES, `${field}.responseMode`);

    // 0.48 M3：升级路由 fail-closed（CONTRACT-0.48 §3.2）。
    const upgrade =
      item.upgrade === undefined
        ? undefined
        : readEnum(item.upgrade, PLUGIN_HTTP_UPGRADES, `${field}.upgrade`);
    if (upgrade !== undefined) {
      if (method !== 'GET') {
        fail('plugin_manifest_invalid', `${field}.upgrade requires method "GET"`);
      }
      // 显式 buffered 与 WS 升级冲突；缺省按 stream 归一化（§3.1）。
      if (responseModeRaw === 'buffered') {
        fail(
          'plugin_manifest_invalid',
          `${field}.responseMode must not be "buffered" for upgrades`,
        );
      }
    }
    const responseMode =
      upgrade !== undefined ? (responseModeRaw ?? 'stream') : (responseModeRaw ?? 'buffered');

    const timeoutMs = optionalPositiveInteger(item.timeoutMs, `${field}.timeoutMs`);
    const maxBodyBytes = optionalPositiveInteger(item.maxBodyBytes, `${field}.maxBodyBytes`);
    const maxResponseBytes = optionalPositiveInteger(
      item.maxResponseBytes,
      `${field}.maxResponseBytes`,
    );
    const idleTimeoutMs = optionalPositiveInteger(item.idleTimeoutMs, `${field}.idleTimeoutMs`);
    const maxFrameBytes = optionalPositiveInteger(item.maxFrameBytes, `${field}.maxFrameBytes`);
    const maxConnections = optionalPositiveInteger(item.maxConnections, `${field}.maxConnections`);

    return {
      id,
      method,
      path: routePath,
      auth,
      scope,
      responseMode,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
      ...(upgrade !== undefined ? { upgrade } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(maxFrameBytes !== undefined ? { maxFrameBytes } : {}),
      ...(maxConnections !== undefined ? { maxConnections } : {}),
    };
  });
}

function isJsonPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function validateCliArgName(name: string, field: string): void {
  if (name.startsWith('-')) {
    fail('plugin_manifest_invalid', `${field} "${name}" must not start with "-"`);
  }
  if (CLI_ARG_RESERVED_NAMES.has(name)) {
    fail('plugin_manifest_invalid', `${field} "${name}" is reserved`);
  }
}

/** 校验 CLI args 的 JSON Schema 子集；越界关键字 / 类型一律 fail-closed */
function readCliArgsSchema(value: unknown, field: string, depth = 0): PluginCliArgsSchema {
  if (depth > CLI_ARG_MAX_DEPTH) {
    fail(
      'plugin_manifest_invalid',
      `${field} is nested too deeply (max depth ${CLI_ARG_MAX_DEPTH})`,
    );
  }
  if (!isRecord(value)) fail('plugin_manifest_invalid', `${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!CLI_ARG_ALLOWED_KEYS.has(key)) {
      fail('plugin_manifest_invalid', `${field}.${key} is not in the CLI args schema subset`);
    }
  }

  const out: PluginCliArgsSchema = {};
  if (value.type !== undefined) out.type = readEnum(value.type, CLI_ARG_TYPES, `${field}.type`);
  if (value.description !== undefined) {
    if (typeof value.description !== 'string') {
      fail('plugin_manifest_invalid', `${field}.description must be a string`);
    }
    out.description = value.description;
  }
  if (value.default !== undefined) out.default = value.default;

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      fail('plugin_manifest_invalid', `${field}.enum must be a non-empty array`);
    }
    value.enum.forEach((entry, index) => {
      if (!isJsonPrimitive(entry)) {
        fail(
          'plugin_manifest_invalid',
          `${field}.enum[${index}] must be a string, number, boolean, or null`,
        );
      }
    });
    out.enum = [...value.enum];
  }

  if (value.required !== undefined) {
    if (!Array.isArray(value.required)) {
      fail('plugin_manifest_invalid', `${field}.required must be an array of strings`);
    }
    out.required = value.required.map((name, index) => {
      const text = requireString(name, `${field}.required[${index}]`);
      validateCliArgName(text, `${field}.required[${index}]`);
      return text;
    });
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      fail('plugin_manifest_invalid', `${field}.properties must be an object`);
    }
    const properties: Record<string, PluginCliArgsSchema> = {};
    for (const [name, schema] of Object.entries(value.properties)) {
      validateCliArgName(name, `${field}.properties`);
      properties[name] = readCliArgsSchema(schema, `${field}.properties.${name}`, depth + 1);
    }
    out.properties = properties;
  }

  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties !== 'boolean') {
      fail('plugin_manifest_invalid', `${field}.additionalProperties must be a boolean`);
    }
    out.additionalProperties = value.additionalProperties;
  }

  if (value.items !== undefined) {
    out.items = readCliArgsSchema(value.items, `${field}.items`, depth + 1);
  }

  const minimum = optionalFiniteNumber(value.minimum, `${field}.minimum`);
  const maximum = optionalFiniteNumber(value.maximum, `${field}.maximum`);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    fail('plugin_manifest_invalid', `${field}.minimum must not exceed maximum`);
  }
  if (minimum !== undefined) out.minimum = minimum;
  if (maximum !== undefined) out.maximum = maximum;

  const minLength = optionalNonNegativeInteger(value.minLength, `${field}.minLength`);
  const maxLength = optionalNonNegativeInteger(value.maxLength, `${field}.maxLength`);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    fail('plugin_manifest_invalid', `${field}.minLength must not exceed maxLength`);
  }
  if (minLength !== undefined) out.minLength = minLength;
  if (maxLength !== undefined) out.maxLength = maxLength;

  const minItems = optionalNonNegativeInteger(value.minItems, `${field}.minItems`);
  const maxItems = optionalNonNegativeInteger(value.maxItems, `${field}.maxItems`);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    fail('plugin_manifest_invalid', `${field}.minItems must not exceed maxItems`);
  }
  if (minItems !== undefined) out.minItems = minItems;
  if (maxItems !== undefined) out.maxItems = maxItems;

  return out;
}

function readCli(
  value: unknown,
  pluginId: string,
  rpcNames: ReadonlySet<string>,
): PluginCliContribution[] {
  if (!Array.isArray(value)) fail('plugin_manifest_invalid', 'contributes.cli must be an array');
  const seenPaths = new Set<string>();
  return value.map((item, index) => {
    const field = `contributes.cli[${index}]`;
    if (!isRecord(item)) fail('plugin_manifest_invalid', `${field} must be an object`);

    const rawPath = item.path;
    if (!Array.isArray(rawPath) || rawPath.length === 0) {
      fail('plugin_manifest_invalid', `${field}.path must be a non-empty array`);
    }
    const cliPath = rawPath.map((segment, segmentIndex) => {
      const text = requireString(segment, `${field}.path[${segmentIndex}]`);
      if (!CLI_PATH_SEGMENT_RE.test(text)) {
        fail(
          'plugin_manifest_invalid',
          `${field}.path[${segmentIndex}] "${text}" must match ${CLI_PATH_SEGMENT_RE.source}`,
        );
      }
      return text;
    });
    if (cliPath[0] !== pluginId) {
      fail('plugin_manifest_invalid', `${field}.path[0] must equal plugin id "${pluginId}"`);
    }
    const pathKey = cliPath.join(' ');
    if (seenPaths.has(pathKey)) {
      fail('plugin_manifest_invalid', `duplicate cli path "${pathKey}"`);
    }
    seenPaths.add(pathKey);

    const description = optionalString(item.description, `${field}.description`);
    const handler = requireString(item.handler, `${field}.handler`);
    if (!PLUGIN_RPC_NAME_RE.test(handler)) {
      fail(
        'plugin_manifest_invalid',
        `${field}.handler "${handler}" must match ${PLUGIN_RPC_NAME_RE.source}`,
      );
    }
    if (!rpcNames.has(handler)) {
      fail(
        'plugin_manifest_invalid',
        `${field}.handler "${handler}" must have a matching contributes.rpc entry`,
      );
    }

    const args =
      item.args === undefined ? undefined : readCliArgsSchema(item.args, `${field}.args`);
    return {
      path: cliPath,
      ...(description !== undefined ? { description } : {}),
      ...(args !== undefined ? { args } : {}),
      handler,
    };
  });
}

function readContributions(
  raw: unknown,
  permissions: PluginPermissions,
  pluginId: string,
  options: PluginManifestOptions,
): PluginContributions | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) fail('plugin_manifest_invalid', 'contributes must be an object');

  const out: PluginContributions = {};
  if (raw.navGroups !== undefined) out.navGroups = readNavGroups(raw.navGroups, pluginId);
  if (raw.i18n !== undefined) out.i18n = readI18n(raw.i18n);
  if (raw.pages !== undefined) out.pages = readPages(raw.pages, pluginId);
  if (raw.commands !== undefined) out.commands = readCommands(raw.commands);
  if (raw.settings !== undefined) out.settings = readSettings(raw.settings);
  if (raw.rpc !== undefined) out.rpc = readRpc(raw.rpc);
  if (raw.events !== undefined) {
    out.events = stringArray(raw.events, 'contributes.events');
  }
  if (raw.panels !== undefined) out.panels = readPanels(raw.panels);
  if (raw.toolbar !== undefined) out.toolbar = readToolbar(raw.toolbar);
  if (raw.http !== undefined) {
    out.http = readHttp(
      raw.http,
      readReservedHttpRoutes(options.reservedHttpRoutes),
      pluginId,
      options.external === true,
    );
  }

  // 命令执行走 rpc：每个 command 必须有同名 rpc 方法（CONTRACT §2.2）。
  const rpcNames = new Set((out.rpc ?? []).map((entry) => entry.name));
  // CLI 命令也经 rpc 执行：handler 必须是已声明的裸方法名（CONTRACT-0.48 §2）。
  if (raw.cli !== undefined) out.cli = readCli(raw.cli, pluginId, rpcNames);
  for (const command of out.commands ?? []) {
    if (!rpcNames.has(command.name)) {
      fail(
        'plugin_manifest_invalid',
        `contributes.commands "${command.name}" must have a matching contributes.rpc entry`,
      );
    }
  }

  // 订阅事件必须是 permissions.events 的子集（支持 `llm.*` 前缀模式）。
  for (const event of out.events ?? []) {
    if (!permissions.events.some((pattern) => globMatches(pattern, event))) {
      fail(
        'plugin_manifest_invalid',
        `contributes.events "${event}" is not allowed by permissions.events`,
      );
    }
  }

  return out;
}

function readDependencies(raw: unknown): PluginDependency {
  const empty: PluginDependency = { plugins: [], ordering: { after: [], before: [] } };
  if (raw === undefined) return empty;
  if (!isRecord(raw)) fail('plugin_manifest_invalid', 'dependencies must be an object');

  const plugins = raw.plugins === undefined ? [] : stringArray(raw.plugins, 'dependencies.plugins');
  let after: string[] = [];
  let before: string[] = [];
  if (raw.ordering !== undefined) {
    if (!isRecord(raw.ordering)) {
      fail('plugin_manifest_invalid', 'dependencies.ordering must be an object');
    }
    if (raw.ordering.after !== undefined) {
      after = stringArray(raw.ordering.after, 'dependencies.ordering.after');
    }
    if (raw.ordering.before !== undefined) {
      before = stringArray(raw.ordering.before, 'dependencies.ordering.before');
    }
  }
  return { plugins, ordering: { after, before } };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/** 解析并校验清单；失败抛 {@link PluginManifestValidationError} */
export function parsePluginManifest(raw: unknown, options: PluginManifestOptions): PluginManifest {
  if (!isRecord(raw)) fail('plugin_manifest_invalid', 'vessel manifest must be an object');

  const id = requireString(raw.id, 'id');
  if (!PLUGIN_ID_RE.test(id)) {
    fail('plugin_manifest_invalid', `id "${id}" must match ${PLUGIN_ID_RE.source}`);
  }
  const name = requireString(raw.name, 'name');
  const version = requireString(raw.version, 'version');
  if (!isValidSemver(version)) {
    fail('plugin_manifest_invalid', `version "${version}" is not a full semver (x.y.z)`);
  }

  if (!isRecord(raw.engines)) fail('plugin_manifest_invalid', 'engines must be an object');
  const vesselRange = requireString(raw.engines.vessel, 'engines.vessel');
  const parsedRange = parseVersionRange(vesselRange);
  if (!parsedRange) {
    fail(
      'plugin_manifest_invalid',
      `engines.vessel "${vesselRange}" is unsupported (use >=x.y / >=x.y.z comparator forms)`,
    );
  }
  const currentVersion = options.vesselVersion ?? readPackageVersion();
  const current = parseSemver(currentVersion);
  if (
    current &&
    !parsedRange.some((alternative) =>
      alternative.every((comparator) => satisfiesComparator(current, comparator)),
    )
  ) {
    fail(
      'plugin_version_incompatible',
      `plugin "${id}" requires vessel ${vesselRange}, current ${currentVersion}`,
    );
  }

  const entry = requireString(raw.entry, 'entry');
  if (!isContainedPath(options.baseDir, entry)) {
    fail('plugin_manifest_invalid', 'entry must stay inside the plugin directory');
  }

  let side: PluginSide = 'both';
  if (raw.side !== undefined) {
    if (raw.side !== 'backend' && raw.side !== 'ui' && raw.side !== 'both') {
      fail('plugin_manifest_invalid', 'side must be backend | ui | both');
    }
    side = raw.side;
  }

  const description = optionalString(raw.description, 'description');

  let ui: { dir: string } | undefined;
  if (raw.ui !== undefined) {
    if (!isRecord(raw.ui)) fail('plugin_manifest_invalid', 'ui must be an object');
    const dir = requireString(raw.ui.dir, 'ui.dir');
    if (!isContainedPath(options.baseDir, dir)) {
      fail('plugin_manifest_invalid', 'ui.dir must stay inside the plugin directory');
    }
    ui = { dir };
  }

  const activationEvents =
    raw.activationEvents === undefined ? [] : stringArray(raw.activationEvents, 'activationEvents');

  // 插件 id 就是 CLI 命名空间首段：不得占用内置命令名（CONTRACT-0.48 §2）。
  if (options.reservedCliNames !== undefined && new Set(options.reservedCliNames).has(id)) {
    fail('plugin_manifest_invalid', `id "${id}" conflicts with a built-in CLI command`);
  }

  const permissions = readPermissions(raw.permissions);
  const contributes = readContributions(raw.contributes, permissions, id, options);
  const dependencies = readDependencies(raw.dependencies);

  if (raw.override !== undefined && typeof raw.override !== 'boolean') {
    fail('plugin_manifest_invalid', 'override must be a boolean');
  }

  if (options.knownPluginIds !== undefined) {
    const known = new Set(options.knownPluginIds);
    for (const dependency of dependencies.plugins) {
      if (!known.has(dependency)) {
        fail(
          'plugin_dependency_missing',
          `plugin "${id}" depends on missing plugin "${dependency}"`,
        );
      }
    }
  }

  return {
    id,
    name,
    version,
    engines: { vessel: vesselRange },
    ...(description !== undefined ? { description } : {}),
    side,
    entry,
    ...(ui !== undefined ? { ui } : {}),
    activationEvents,
    ...(contributes !== undefined ? { contributes } : {}),
    permissions,
    dependencies,
    ...(raw.override === true ? { override: true } : {}),
  };
}

/** 非抛出版本：解析 / 校验失败返回 `{ ok: false, error }` */
export function validatePluginManifest(
  raw: unknown,
  options: PluginManifestOptions,
): PluginManifestValidation {
  try {
    return { ok: true, manifest: parsePluginManifest(raw, options) };
  } catch (error) {
    if (error instanceof PluginManifestValidationError) return { ok: false, error };
    throw error;
  }
}
