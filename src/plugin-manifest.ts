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

function readContributions(
  raw: unknown,
  permissions: PluginPermissions,
  pluginId: string,
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

  // 命令执行走 rpc：每个 command 必须有同名 rpc 方法（CONTRACT §2.2）。
  const rpcNames = new Set((out.rpc ?? []).map((entry) => entry.name));
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

  const permissions = readPermissions(raw.permissions);
  const contributes = readContributions(raw.contributes, permissions, id);
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
