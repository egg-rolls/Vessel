/**
 * 体验型 plugin 宿主管理器（CONTRACT-0.43 §3–§6）。
 *
 * 负责：descriptor 复检、按需激活 / 停用、子进程重启上限、动态 RPC 注册、
 * 事件白名单转发与限流、`plugins.list` 渲染贡献、静态 UI 挂载。
 *
 * 生命周期边界是子进程；**不是安全沙箱**（DECISION-044 §1.5）。
 *
 * @module @vessel-agent/serve/plugin-host
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { logEvent } from '../log-event.js';
import { type ChildExitInfo, ChildPluginProcess, type PLUGIN_TIMEOUTS } from './child.js';
import { jsonDtoViolation } from './dto.js';
import { PluginHostError, pluginError, pluginErrorCodeOf } from './errors.js';
import { EventRateLimiter, matchesEventFilter } from './events.js';
import type { PluginExposeConfig } from './expose.js';
import {
  buildPluginHttpRouteTable,
  isHostReservedPath,
  isPluginHttpPathReserved,
  matchPluginHttpRoute,
  normalizePluginHttpDeclarations,
  type PluginHttpAuditEvent,
  type PluginHttpHostLike,
  type PluginHttpLimits,
  type PluginHttpMatch,
  type PluginHttpResolution,
  type PluginHttpRoute,
  type PluginHttpRouteConflict,
  type PluginHttpTarget,
  type PluginWebSocketAccounting,
  type PluginWebSocketHandle,
  resolvePluginHttpLimits,
} from './http.js';
import {
  PLUGIN_ID_PATTERN,
  type PluginRpcHandler,
  PluginRpcRegistry,
  pluginRpcName,
} from './registry.js';
import type {
  PluginContributionsSnapshot,
  PluginDescriptor,
  PluginErrorCode,
  PluginEventDto,
  PluginEventSource,
  PluginHostManagerLike,
  PluginListMetadata,
  PluginListStatus,
  PluginReloadError,
  PluginReloadResult,
  PluginRenderContributions,
  PluginRuntimeStatus,
  PluginSettingSpec,
  PluginStaticMount,
  PluginStatusEntry,
  PluginUiTrust,
} from './types.js';
import {
  PLUGIN_BUILTIN_NAV,
  PLUGIN_I18N_LOCALES,
  PLUGIN_ICON_NAMES,
  type PluginI18n,
  type PluginLocale,
} from './types.js';

/** 重启窗口与上限（contract §3.4） */
export const PLUGIN_RESTART_WINDOW_MS = 10 * 60 * 1000;
export const PLUGIN_MAX_RESTARTS = 3;

export type PluginLogger = (
  level: 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface PluginHostManagerOptions {
  descriptors: readonly PluginDescriptor[];
  /** `<dataDir>`；plugin 私有目录为 `<dataDir>/plugins/<id>`。 */
  dataDir: string;
  eventSource?: PluginEventSource;
  eventsPerSecond?: number;
  /** 事件 DTO 的额外变换（在事件源之后、白名单之前）。 */
  redact?: (event: PluginEventDto) => PluginEventDto;
  /**
   * 懒激活时解析 settings（缺省 `{}`）；显式 activate 的 settings 优先。
   * TI5-6 起亦作元数据读端口：statusOf 经它取持久化 config 快照进 plugins.list
   * （装配注入读 liveConfig 的实现 → 写后回显新鲜；缺省回退 descriptor.settings）。
   */
  settingsFor?: (id: string) => Record<string, unknown>;
  logger?: PluginLogger;
  onEventDropped?: (pluginId: string, dropped: number) => void;
  onPermissionDenied?: (pluginId: string, api: string) => void;
  onReady?: (pluginId: string) => void;
  onStateChange?: (status: PluginStatusEntry) => void;
  /** reload 后的 `plugin.changed` 快照；gateway 用它广播。 */
  onChanged?: (snapshot: PluginContributionsSnapshot) => void;
  execPath?: string;
  /** 覆盖子进程协议超时（探针 / 测试用）。 */
  timeouts?: Partial<typeof PLUGIN_TIMEOUTS>;
  restartWindowMs?: number;
  maxRestarts?: number;
  restartDelayMs?: number;
  now?: () => number;
  /** 0.48 M1：宿主默认 HTTP 限额；manifest 只能收紧。 */
  httpLimits?: PluginHttpLimits;
  /** 0.48 M1：宿主保留路径判定（缺省 `isHostReservedPath`）。 */
  httpReservedPath?: (pathname: string) => boolean;
  /** 0.48 M4：按插件 id 读取 config `plugins[].expose`；builtin 忽略。 */
  exposeFor?: (pluginId: string) => PluginExposeConfig | undefined;
}

/** 0.48 M3：WS 连接计数（只进日志 / 诊断，不新增 RPC）。 */
export interface PluginWebSocketStats {
  active: number;
  total: number;
  rejected: number;
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  lastCloseCode?: number;
}

function emptyWebSocketStats(): PluginWebSocketStats {
  return {
    active: 0,
    total: 0,
    rejected: 0,
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
  };
}

interface Entry {
  descriptor: PluginDescriptor;
  enabled: boolean;
  status: PluginRuntimeStatus;
  error?: PluginErrorCode;
  message?: string;
  child?: ChildPluginProcess;
  unsubscribe?: () => void;
  limiter: EventRateLimiter;
  dropped: number;
  denials: number;
  restarts: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
  settings: Record<string, unknown>;
  /** 本次 spawn 的插件 HTTP endpoint + 内部 token；非 active 时清空。 */
  httpEndpoint?: PluginHttpTarget;
  /** plugin-embed 契约 §3：加载 / reload 时计算的信任态；无 embed 时缺省。 */
  embedState?: { trust: PluginUiTrust; hash: string };
}

/**
 * in-process 能力插件登记项（双轨中的另一轨）。
 * 没有 child / status 维度：登记即激活，与进程同寿命；
 * handler 留存以支持 disable → enable 的 RPC 重注册。
 */
interface InProcessRecord {
  descriptor: PluginDescriptor;
  enabled: boolean;
  /** 插件自己的 `Plugin.rpc`（传输无关）；未声明 contributes.rpc 时缺省。 */
  handler?: PluginRpcHandler;
  /** plugin-embed 契约 §3：登记时计算的信任态（与 child 同一算法）。 */
  embedState?: { trust: PluginUiTrust; hash: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** 相对 UI 入口：拒绝绝对路径、`..`、反斜杠。 */
function isPluginIconName(value: unknown): boolean {
  return typeof value === 'string' && (PLUGIN_ICON_NAMES as readonly string[]).includes(value);
}

const I18N_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const I18N_FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const I18N_MAX_KEYS = 200;
const I18N_MAX_VALUE_CHARS = 200;

/**
 * 校验并复制插件私有 i18n（CONTRACT-0.43 §2.11 E9）。
 * 只允许 en / zh-CN；拒绝原型污染键；返回新的普通对象，不把调用方的
 * 对象引用带进 contributions。
 */
function normalizeI18n(raw: unknown, pluginId: string): PluginI18n | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw pluginError('plugin_manifest_invalid', 'contributes.i18n must be an object.', {
      id: pluginId,
    });
  }
  const output: PluginI18n = {};
  for (const [locale, dictionary] of Object.entries(raw as Record<string, unknown>)) {
    if (!(PLUGIN_I18N_LOCALES as readonly string[]).includes(locale)) {
      throw pluginError('plugin_manifest_invalid', `Unsupported i18n locale: ${locale}`, {
        id: pluginId,
        locale,
      });
    }
    if (typeof dictionary !== 'object' || dictionary === null || Array.isArray(dictionary)) {
      throw pluginError('plugin_manifest_invalid', 'i18n locale must be an object.', {
        id: pluginId,
        locale,
      });
    }
    const entries = Object.entries(dictionary as Record<string, unknown>);
    if (entries.length > I18N_MAX_KEYS) {
      throw pluginError('plugin_manifest_invalid', 'i18n locale has too many keys.', {
        id: pluginId,
        locale,
        count: entries.length,
      });
    }
    const clean: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (I18N_FORBIDDEN_KEYS.has(key) || !I18N_KEY_PATTERN.test(key)) {
        throw pluginError('plugin_manifest_invalid', `Invalid i18n key: ${key}`, {
          id: pluginId,
          locale,
          key,
        });
      }
      if (typeof value !== 'string' || value.length === 0 || value.length > I18N_MAX_VALUE_CHARS) {
        throw pluginError('plugin_manifest_invalid', `Invalid i18n value for key: ${key}`, {
          id: pluginId,
          locale,
          key,
        });
      }
      clean[key] = value;
    }
    output[locale as PluginLocale] = clean;
  }
  return output;
}

/** 内置分组，或本 plugin 自己声明的 `plugin:<id>`；跨 plugin 引用拒绝。 */
function isValidPageNav(nav: unknown, pluginId: string, hasOwnGroup: boolean): boolean {
  if (typeof nav !== 'string' || nav.length === 0) return false;
  if ((PLUGIN_BUILTIN_NAV as readonly string[]).includes(nav)) return true;
  return nav === `plugin:${pluginId}` && hasOwnGroup;
}

function isSafeRelativeEntry(entry: unknown): entry is string {
  if (typeof entry !== 'string' || entry.length === 0) return false;
  if (entry.startsWith('/') || entry.startsWith('\\')) return false;
  if (entry.includes('\\') || entry.includes('\0')) return false;
  return !entry.split('/').some((segment) => segment === '..' || segment === '.');
}

function safeEntry(entry: string): string {
  return entry.replace(/^\.\//, '');
}

function eventSubsetOfPermissions(
  contributed: readonly string[],
  permissions: readonly string[],
): boolean {
  return contributed.every((pattern) =>
    permissions.some(
      (allowed) =>
        allowed === '*' ||
        allowed === pattern ||
        (allowed.endsWith('.*') && pattern.startsWith(allowed.slice(0, -1))),
    ),
  );
}

// ── plugin-embed（契约 §1 / §3）：信任档 + 哈希锁 ──────────────────────────

/** `pages[].component` 形状（与 manifest 侧同一规则；serve 不 import src/）。 */
const PLUGIN_COMPONENT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * 递归收集常规文件（相对路径 `/` 分隔）。symlink → 抛错（契约 §3 fail-closed）：
 * 符号链接目标可以在不改变哈希的情况下被换掉，会绕过 TOFU 哈希锁；
 * 整个 embed 视同不可读（字段缺省，前端回落 iframe）。
 */
function collectEmbedFiles(root: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`symlink in embed dir: ${rel}`);
    if (entry.isDirectory()) collectEmbedFiles(join(root, entry.name), rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/**
 * ui_bundle_hash（契约 §3）：embedRoot 下全部文件按相对路径排序，逐文件
 * sha256，再对 `concat(relpath + "\0" + fileHash + "\n")` 取 sha256。
 * embedRoot 不存在 / 不可读 → null（视同无 embed，fail-closed）。
 */
function computeEmbedHash(embedRoot: string): string | null {
  try {
    const files: string[] = [];
    collectEmbedFiles(embedRoot, '', files);
    files.sort();
    let listing = '';
    for (const rel of files) {
      listing += `${rel}\0${sha256Hex(readFileSync(resolve(embedRoot, rel)))}\n`;
    }
    return sha256Hex(listing);
  } catch {
    return null;
  }
}

/**
 * 信任档判定（契约 §1）：builtin → embedded；其他来源需 config `trust_ui:
 * embedded` 且 TOFU 哈希锁一致。无锁 → 钉住当前哈希（写锁失败 → isolated）；
 * 锁不等 / 损坏 / 读错误 → isolated，**不自动更新锁**（P4 重新确认）。
 */
function resolveUiTrust(
  descriptor: PluginDescriptor,
  hash: string,
  dataDir: string,
  logger: PluginLogger,
): PluginUiTrust {
  if (descriptor.builtin === true) return 'embedded';
  if (descriptor.trustUi !== 'embedded') return 'isolated';
  const lockPath = join(dataDir, 'plugins', descriptor.id, 'ui-bundle.lock.json');
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'isolated';
    // 无锁 → TOFU 钉住当前哈希。宿主侧写（不经插件子进程）；tmp + rename 防半写。
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      const record = `${JSON.stringify({ sha256: hash, recordedAt: new Date().toISOString() })}\n`;
      const tmpPath = `${lockPath}.tmp`;
      writeFileSync(tmpPath, record, { mode: 0o600 });
      renameSync(tmpPath, lockPath);
      return 'embedded';
    } catch {
      logger('warn', 'plugin ui trust lock write failed; staying isolated', {
        plugin: descriptor.id,
      });
      return 'isolated';
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'isolated';
  }
  if (isRecord(parsed) && parsed.sha256 === hash) return 'embedded';
  return 'isolated';
}

/** 相对 uiDir 的 embed 路径归一化（`/` 分隔，去 `./` 与空段），供缓存头比对。 */
function normalizeEmbedRelPath(value: string): string {
  return value
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** descriptor 复检；loader 已校验过一遍，这里 fail-closed 防注入。 */
function validateDescriptor(
  input: PluginDescriptor,
  hostLimits: PluginHttpLimits = resolvePluginHttpLimits(),
  isReservedPath: (pathname: string) => boolean = isHostReservedPath,
): PluginDescriptor {
  if (typeof input.id !== 'string' || !PLUGIN_ID_PATTERN.test(input.id)) {
    throw pluginError('plugin_manifest_invalid', `Invalid plugin id: ${String(input.id)}`);
  }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    throw pluginError('plugin_manifest_invalid', 'Plugin name is required.', { id: input.id });
  }
  if (typeof input.version !== 'string' || input.version.length === 0) {
    throw pluginError('plugin_manifest_invalid', 'Plugin version is required.', { id: input.id });
  }
  if (typeof input.pluginDir !== 'string' || input.pluginDir.length === 0) {
    throw pluginError('plugin_manifest_invalid', 'pluginDir is required.', { id: input.id });
  }
  const pluginDir = resolve(input.pluginDir);
  const entry = resolve(pluginDir, input.entry);
  if (!isWithin(pluginDir, entry) || entry === pluginDir) {
    throw pluginError('plugin_manifest_invalid', 'entry must stay inside pluginDir.', {
      id: input.id,
    });
  }
  const uiDir = input.uiDir !== undefined ? resolve(pluginDir, input.uiDir) : undefined;
  if (uiDir !== undefined && !isWithin(pluginDir, uiDir)) {
    throw pluginError('plugin_manifest_invalid', 'ui.dir must stay inside pluginDir.', {
      id: input.id,
    });
  }
  // plugin-embed 契约 §2：ui.embed 结构复检（manifest 已校验过一遍，防注入）。
  const uiEmbed = input.uiEmbed;
  if (uiEmbed !== undefined) {
    if (uiDir === undefined) {
      throw pluginError('plugin_manifest_invalid', 'ui.embed requires ui.dir.', { id: input.id });
    }
    if (!isSafeRelativeEntry(uiEmbed.entry) || !uiEmbed.entry.endsWith('.mjs')) {
      throw pluginError('plugin_manifest_invalid', 'ui.embed.entry must be a relative .mjs path.', {
        id: input.id,
      });
    }
    if (
      uiEmbed.css !== undefined &&
      (!isSafeRelativeEntry(uiEmbed.css) || !uiEmbed.css.endsWith('.css'))
    ) {
      throw pluginError('plugin_manifest_invalid', 'ui.embed.css must be a relative .css path.', {
        id: input.id,
      });
    }
    if (
      typeof uiEmbed.runtime?.react !== 'string' ||
      uiEmbed.runtime.react.length === 0 ||
      typeof uiEmbed.runtime?.sdk !== 'string' ||
      uiEmbed.runtime.sdk.length === 0
    ) {
      throw pluginError(
        'plugin_manifest_invalid',
        'ui.embed.runtime requires react and sdk ranges.',
        { id: input.id },
      );
    }
  }
  if (input.trustUi !== undefined && input.trustUi !== 'embedded') {
    throw pluginError('plugin_manifest_invalid', 'trustUi must be "embedded" when present.', {
      id: input.id,
    });
  }

  const contributes = input.contributes ?? {};
  const i18n = normalizeI18n(contributes.i18n, input.id);
  const permissions = input.permissions ?? {};
  const events = contributes.events ?? [];
  if (events.length > 0 && !eventSubsetOfPermissions(events, permissions.events ?? [])) {
    throw pluginError(
      'plugin_manifest_invalid',
      'contributes.events must be a subset of permissions.events.',
      { id: input.id },
    );
  }
  const rpcNames = new Set<string>();
  for (const method of contributes.rpc ?? []) {
    pluginRpcName(input.id, method.name);
    if (
      method.permission !== undefined &&
      method.permission !== 'read' &&
      method.permission !== 'write'
    ) {
      throw pluginError('plugin_manifest_invalid', 'rpc[].permission must be read or write.', {
        id: input.id,
        method: method.name,
        permission: method.permission,
      });
    }
    if (rpcNames.has(method.name)) {
      throw pluginError('plugin_manifest_invalid', `Duplicate plugin rpc: ${method.name}`, {
        id: input.id,
      });
    }
    rpcNames.add(method.name);
  }
  // E5：v1 每个 plugin 最多一个自定义分组，id 必须是 `plugin:<pluginId>`。
  const rawNavGroups = contributes.navGroups;
  if (rawNavGroups !== undefined && !Array.isArray(rawNavGroups)) {
    throw pluginError('plugin_manifest_invalid', 'navGroups must be an array.', { id: input.id });
  }
  const navGroups = rawNavGroups ?? [];
  if (navGroups.length > 1) {
    throw pluginError('plugin_manifest_invalid', 'At most one navGroups entry is allowed.', {
      id: input.id,
    });
  }
  const ownGroupId = `plugin:${input.id}`;
  for (const group of navGroups) {
    if (group.id !== ownGroupId || (PLUGIN_BUILTIN_NAV as readonly string[]).includes(group.id)) {
      throw pluginError('plugin_manifest_invalid', 'navGroups[].id must be plugin:<pluginId>.', {
        id: input.id,
        group: group.id,
      });
    }
    if (typeof group.title !== 'string' || group.title.length === 0) {
      throw pluginError('plugin_manifest_invalid', 'navGroups[].title is required.', {
        id: input.id,
      });
    }
    if (group.icon !== undefined && !isPluginIconName(group.icon)) {
      throw pluginError('plugin_manifest_invalid', 'navGroups[].icon is invalid.', {
        id: input.id,
        icon: group.icon,
      });
    }
    if (
      group.order !== undefined &&
      (typeof group.order !== 'number' || !Number.isFinite(group.order))
    ) {
      throw pluginError('plugin_manifest_invalid', 'navGroups[].order must be a number.', {
        id: input.id,
      });
    }
  }
  const hasOwnGroup = navGroups.some((group) => group.id === ownGroupId);

  for (const page of contributes.pages ?? []) {
    if (typeof page.id !== 'string' || page.id.length === 0 || typeof page.title !== 'string') {
      throw pluginError('plugin_manifest_invalid', 'pages[] requires id and title.', {
        id: input.id,
      });
    }
    if (!isSafeRelativeEntry(page.entry)) {
      throw pluginError('plugin_manifest_invalid', 'pages[].entry must be relative.', {
        id: input.id,
      });
    }
    if (page.component !== undefined) {
      if (typeof page.component !== 'string' || !PLUGIN_COMPONENT_PATTERN.test(page.component)) {
        throw pluginError('plugin_manifest_invalid', 'pages[].component must be a JS identifier.', {
          id: input.id,
        });
      }
      if (uiEmbed === undefined) {
        throw pluginError('plugin_manifest_invalid', 'pages[].component requires ui.embed.', {
          id: input.id,
        });
      }
    }
    if (page.nav !== undefined && !isValidPageNav(page.nav, input.id, hasOwnGroup)) {
      throw pluginError('plugin_manifest_invalid', 'pages[].nav is invalid.', {
        id: input.id,
        nav: page.nav,
      });
    }
    if (page.icon !== undefined && !isPluginIconName(page.icon)) {
      throw pluginError('plugin_manifest_invalid', 'pages[].icon is invalid.', {
        id: input.id,
        icon: page.icon,
      });
    }
    if (
      page.order !== undefined &&
      (typeof page.order !== 'number' || !Number.isFinite(page.order))
    ) {
      throw pluginError('plugin_manifest_invalid', 'pages[].order must be a number.', {
        id: input.id,
      });
    }
  }
  for (const panel of contributes.panels ?? []) {
    if (typeof panel.slot !== 'string' || typeof panel.id !== 'string') {
      throw pluginError('plugin_manifest_invalid', 'panels[] requires slot and id.', {
        id: input.id,
      });
    }
    if (!isSafeRelativeEntry(panel.entry)) {
      throw pluginError('plugin_manifest_invalid', 'panels[].entry must be relative.', {
        id: input.id,
      });
    }
  }
  // 0.51 additive：工具栏按钮是 declarative 声明，没有 entry；只校验形状与槽位。
  for (const item of contributes.toolbar ?? []) {
    if (typeof item.id !== 'string' || typeof item.label !== 'string') {
      throw pluginError('plugin_manifest_invalid', 'toolbar[] requires id and label.', {
        id: input.id,
      });
    }
    if (item.slot !== 'composer') {
      throw pluginError('plugin_manifest_invalid', 'toolbar[].slot must be "composer".', {
        id: input.id,
      });
    }
    // file-ref P3 additive：action = embed 具名导出（JS 标识符形状），与 menu
    // 互斥，须 ui.embed（fail-closed，与内置 loader readToolbar 镜像同款）。
    if (item.action !== undefined) {
      if (typeof item.action !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item.action)) {
        throw pluginError(
          'plugin_manifest_invalid',
          'toolbar[].action must be a JS identifier (embed named export).',
          { id: input.id },
        );
      }
      if (item.menu !== undefined) {
        throw pluginError(
          'plugin_manifest_invalid',
          'toolbar[].action and menu are mutually exclusive.',
          { id: input.id },
        );
      }
      if (uiEmbed === undefined) {
        throw pluginError('plugin_manifest_invalid', 'toolbar[].action requires ui.embed.', {
          id: input.id,
        });
      }
    }
  }

  // 0.48 M1：HTTP 声明在 descriptor 复检阶段归一化；非法 → 插件 invalid。
  const http = normalizePluginHttpDeclarations(
    input.id,
    contributes.http,
    input.builtin === true,
    hostLimits,
  );
  for (const declaration of http) {
    // 保留路由冲突只让该插件的 HTTP 面失效（插件 invalid），不拖垮其它插件。
    // 0.48 M4：外部插件在自己的 `/plugins/<own-id>/` 命名空间内豁免保留前缀。
    if (
      isPluginHttpPathReserved(input.id, input.builtin === true, declaration.path, isReservedPath)
    ) {
      throw pluginError(
        'plugin_manifest_invalid',
        `contributes.http[${declaration.id}].path conflicts with a host-reserved route: ${declaration.path}`,
        { id: input.id, route: declaration.id, path: declaration.path },
      );
    }
  }

  return {
    ...input,
    pluginDir,
    entry,
    ...(input.contributes !== undefined
      ? {
          contributes: {
            ...contributes,
            ...(i18n !== undefined ? { i18n } : {}),
            ...(http.length > 0 ? { http } : {}),
          },
        }
      : {}),
    ...(uiDir !== undefined ? { uiDir } : {}),
  };
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    default:
      // 未声明的 type 子集：不做臆测
      return true;
  }
}

/** 只保留 manifest 声明过的 settings；未声明键告警后丢弃。 */
function filterSettings(
  descriptor: PluginDescriptor,
  input: Record<string, unknown>,
  warn: (message: string, meta?: Record<string, unknown>) => void,
): Record<string, unknown> {
  const schema = descriptor.contributes?.settings;
  const output: Record<string, unknown> = {};
  if (schema === undefined) {
    if (Object.keys(input).length > 0) {
      warn('plugin settings ignored: manifest declares no contributes.settings', {
        plugin: descriptor.id,
      });
    }
    return output;
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = schema[key];
    if (!isRecord(spec)) {
      warn('plugin settings key ignored: not declared in manifest', {
        plugin: descriptor.id,
        key,
      });
      continue;
    }
    if (!typeMatches(spec.type, value)) {
      throw pluginError('plugin_config_invalid', `Setting "${key}" has the wrong type.`, {
        plugin: descriptor.id,
        key,
        expected: spec.type,
      });
    }
    output[key] = value;
  }
  return output;
}

function routeFor(pluginId: string, entry: string): string {
  return `/plugins/${pluginId}/${safeEntry(entry)}`;
}

/** 确定性序列化（key 排序），用于 descriptor 指纹。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** reload diff 指纹（CONTRACT-0.43 §2.8）。 */
function descriptorFingerprint(descriptor: PluginDescriptor): string {
  return stableStringify({
    entry: descriptor.entry,
    uiDir: descriptor.uiDir ?? null,
    version: descriptor.version,
    contributes: descriptor.contributes ?? {},
    permissions: descriptor.permissions ?? {},
    enabled: descriptor.enabled ?? true,
    builtin: descriptor.builtin ?? false,
    uiEmbed: descriptor.uiEmbed ?? null,
    trustUi: descriptor.trustUi ?? null,
    // q-plugin-lifecycle §6.5 P2：settings 值进指纹 → 改 settings 触发子进程重激活
    //（spawn 期 env 注入新值），child settings 转热。缺省 {} 与历史无 settings 行为一致。
    settings: descriptor.settings ?? {},
  });
}

/**
 * 单进程内的 plugin 宿主（0.49 T3：单执行面）。启用列表由 loader 决定；
 * 事件订阅只有一条运行时流。
 */
export class PluginHostManager implements PluginHostManagerLike, PluginHttpHostLike {
  readonly rpc = new PluginRpcRegistry();

  private readonly entries = new Map<string, Entry>();
  /**
   * model-registry D3：已登记的 in-process 能力插件。
   * 不进 `entries`：reload diff / 懒激活 spawn / 重启上限都是 child 语义；
   * in-process 与进程同寿命，RPC 注销由 stopAll 的 rpc.clear() 覆盖。
   *
   * 双轨口径（S8）：凡「面向插件整体」的读面（statuses / status /
   * contributionsFor / contributionsSnapshot / staticMounts / ensureActive /
   * enable / disable / activate）必须同时遍历 entries 与本 map；
   * 凡「child 机制」的面（spawn / 重启 / 事件管道 / 动态 HTTP 代理 / WS 代理）
   * 只作用于 entries，见各方法注释。
   */
  private readonly inProcess = new Map<string, InProcessRecord>();
  private readonly dataDir: string;
  private readonly logger: PluginLogger;
  private readonly now: () => number;
  private readonly eventsPerSecond: number;
  private readonly restartWindowMs: number;
  private readonly maxRestarts: number;
  private readonly restartDelayMs: number;
  private eventSource?: PluginEventSource;
  private readonly options: PluginHostManagerOptions;
  private readonly httpLimits: PluginHttpLimits;
  private httpRoutes: readonly PluginHttpRoute[] = [];
  private httpConflicts: readonly PluginHttpRouteConflict[] = [];
  /** 0.48 M4：builtin 的 `expose` 被忽略时只告警一次。 */
  private readonly warnedBuiltinExpose = new Set<string>();
  /** 0.48 M3：pluginId → 打开的客户端 WS。 */
  private readonly wsConnections = new Map<string, Set<PluginWebSocketHandle>>();
  private readonly wsStats = new Map<string, PluginWebSocketStats>();

  /** 0.48 M3：WS 登记 / 计数器 / 审计（gateway 经 `PluginHttpHostLike` 使用）。 */
  readonly webSockets: PluginWebSocketAccounting = {
    register: (pluginId, handle) => {
      let set = this.wsConnections.get(pluginId);
      if (set === undefined) {
        set = new Set<PluginWebSocketHandle>();
        this.wsConnections.set(pluginId, set);
      }
      set.add(handle);
      const stats = this.statsFor(pluginId);
      stats.active += 1;
      stats.total += 1;
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        set.delete(handle);
        if (set.size === 0) this.wsConnections.delete(pluginId);
      };
    },
    frame: (pluginId, direction, bytes) => {
      const stats = this.statsFor(pluginId);
      if (direction === 'in') {
        stats.framesIn += 1;
        stats.bytesIn += bytes;
      } else {
        stats.framesOut += 1;
        stats.bytesOut += bytes;
      }
    },
    closed: (pluginId, code) => {
      const stats = this.statsFor(pluginId);
      stats.active = Math.max(0, stats.active - 1);
      stats.lastCloseCode = code;
    },
    rejected: (pluginId) => {
      this.statsFor(pluginId).rejected += 1;
    },
    audit: (event: PluginHttpAuditEvent) => {
      // 结构化审计只进 logger；不含 header / body / token / query。
      this.logger('warn', event.event, { ...event.data });
    },
  };

  constructor(options: PluginHostManagerOptions) {
    this.options = options;
    this.dataDir = resolve(options.dataDir);
    this.logger =
      options.logger ??
      ((level, message, meta) => {
        // 统一走事件行排版（消灭 `[vessel] 自由文本 + JSON.stringify` 第三种格式）。
        logEvent(level, message, meta ?? {});
      });
    this.now = options.now ?? Date.now;
    this.eventsPerSecond = options.eventsPerSecond ?? 200;
    this.restartWindowMs = options.restartWindowMs ?? PLUGIN_RESTART_WINDOW_MS;
    this.maxRestarts = options.maxRestarts ?? PLUGIN_MAX_RESTARTS;
    this.restartDelayMs = options.restartDelayMs ?? 0;
    this.eventSource = options.eventSource;
    this.httpLimits = options.httpLimits ?? resolvePluginHttpLimits();

    for (const input of options.descriptors) {
      let descriptor: PluginDescriptor;
      try {
        descriptor = validateDescriptor(
          input,
          this.httpLimits,
          this.options.httpReservedPath ?? isHostReservedPath,
        );
      } catch (error) {
        const id = typeof input.id === 'string' ? input.id : '<invalid>';
        const status: PluginStatusEntry = {
          id,
          status: 'invalid',
          enabled: false,
          error: pluginErrorCodeOf(error) ?? 'plugin_manifest_invalid',
          message: error instanceof Error ? error.message : String(error),
          events_dropped: 0,
          restarts: 0,
        };
        // 无效 descriptor 不注册，只保留可诊断状态。
        this.entries.set(id, {
          descriptor: { ...input, id, name: id, version: '', entry: '', pluginDir: '' },
          enabled: false,
          status: 'invalid',
          error: status.error,
          message: status.message,
          limiter: new EventRateLimiter(this.eventsPerSecond, this.now),
          dropped: 0,
          denials: 0,
          restarts: [],
          settings: {},
        });
        continue;
      }
      if (this.entries.has(descriptor.id)) {
        const existing = this.entries.get(descriptor.id) as Entry;
        existing.enabled = false;
        existing.status = 'invalid';
        existing.error = 'plugin_id_conflict';
        existing.message = `Duplicate plugin id: ${descriptor.id}`;
        this.logger('error', 'plugin id conflict; refusing activation', {
          plugin: descriptor.id,
        });
        continue;
      }
      const entry = this.makeEntry(descriptor);
      this.entries.set(descriptor.id, entry);
      // 懒激活：RPC 定义在 enable 时就注册，首次调用 / 首次页面访问再 spawn。
      this.registerRpc(entry);
    }
    this.rebuildHttpRoutes();
  }

  /**
   * 按需激活（activationEvents 命中后由 loader 调用）；settings 单份。
   * 双轨：in-process 登记即激活，enabled no-op（settings 在 install 时已给定，
   * 这里不再下发）；disabled 抛同款契约错误。child 走 spawn。
   */
  async activate(id: string, options: { settings?: Record<string, unknown> } = {}): Promise<void> {
    const inProcessRecord = this.inProcess.get(id);
    if (inProcessRecord !== undefined) {
      if (!inProcessRecord.enabled) {
        throw pluginError('plugin_activation_failed', `Plugin ${id} is disabled.`, { id });
      }
      return;
    }
    const entry = this.requireEntry(id);
    if (!entry.enabled) {
      throw pluginError('plugin_activation_failed', `Plugin ${id} is disabled.`, { id });
    }
    if (entry.status === 'invalid') {
      throw pluginError(
        entry.error ?? 'plugin_manifest_invalid',
        entry.message ?? 'Invalid plugin.',
        {
          id,
        },
      );
    }
    await this.startEntry(entry, options.settings ?? {});
  }

  /**
   * 懒激活入口（v1）：首次页面访问 / 首次 `plugin.<id>.*` 调用触发 spawn。
   * `activationEvents.onPage:*` / `onCommand:*` 是声明元数据，v1 不做预激活；
   * active 时 no-op，disabled / invalid 抛契约错误。
   * in-process 能力插件与进程同寿命、登记即激活，无 child 可 spawn：
   * enabled 直接放行，disabled 抛同款契约错误；不走 requireEntry（只查
   * child entries，会把已登记的 in-process 当未知插件拒掉）。
   */
  async ensureActive(id: string): Promise<void> {
    const inProcessRecord = this.inProcess.get(id);
    if (inProcessRecord !== undefined) {
      if (!inProcessRecord.enabled) {
        throw pluginError('plugin_activation_failed', `Plugin ${id} is disabled.`, { id });
      }
      return;
    }
    const entry = this.requireEntry(id);
    if (!entry.enabled || entry.status === 'disabled') {
      throw pluginError('plugin_activation_failed', `Plugin ${id} is disabled.`, { id });
    }
    if (entry.status === 'invalid') {
      throw pluginError(
        entry.error ?? 'plugin_manifest_invalid',
        entry.message ?? 'Invalid plugin.',
        { id },
      );
    }
    if (entry.status === 'active') return;
    const settings = this.options.settingsFor?.(id) ?? {};
    await this.startEntry(entry, settings);
  }

  /**
   * 热重载 descriptors（CONTRACT-0.43 §2.8 Errata E3）。
   *
   * 按 id + 指纹 diff：新增 → inactive；变更 → 先 deactivate，替换 descriptor，
   * 原先 active 的立即重新激活；删除 → deactivate、注销 RPC / 静态挂载、删条目。
   * 单个 plugin 的失败只进 `errors[]`，不抛出、不影响其它 plugin。
   * 不扫描目录 / 不读 config —— discovery 由 N-loader 负责。
   *
   * child-only（S8 边界）：diff 只作用于 child entries。in-process 登记由装配层
   * 负责（registerInProcess），不参与热重载（变化 → 装配层报 restart_required）；
   * 删除循环不会误删 in-process。若 reload 列表混入已登记的 in-process id，
   * fail-closed 报 plugin_id_conflict，绝不建影子 child 条目（否则贡献面 /
   * 静态挂载会出现同 id 双份）。
   */
  async reload(descriptors: readonly PluginDescriptor[]): Promise<PluginReloadResult> {
    const errors: PluginReloadError[] = [];
    const normalized = new Map<string, PluginDescriptor>();
    const seen = new Set<string>();

    for (const input of descriptors) {
      const id = typeof input?.id === 'string' ? input.id : '<invalid>';
      seen.add(id);
      try {
        const descriptor = validateDescriptor(
          input,
          this.httpLimits,
          this.options.httpReservedPath ?? isHostReservedPath,
        );
        if (normalized.has(descriptor.id)) {
          throw pluginError('plugin_id_conflict', `Duplicate plugin id: ${descriptor.id}`, {
            id: descriptor.id,
          });
        }
        normalized.set(descriptor.id, descriptor);
      } catch (error) {
        errors.push({
          id,
          code: pluginErrorCodeOf(error) ?? 'plugin_manifest_invalid',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];

    // 删除：新列表里连 id 都没有的条目。无效 manifest 仍保留旧条目（fail-closed）。
    for (const id of [...this.entries.keys()]) {
      if (seen.has(id)) continue;
      try {
        await this.deactivate(id);
        this.rpc.unregister(id);
        this.entries.delete(id);
        this.wsStats.delete(id);
        removed.push(id);
      } catch (error) {
        errors.push({
          id,
          code: pluginErrorCodeOf(error) ?? 'plugin_activation_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const [id, descriptor] of normalized) {
      const existing = this.entries.get(id);
      if (existing === undefined) {
        // in-process 已登记的 id 不得再建 child 条目（影子双注册）；fail-closed。
        if (this.inProcess.has(id)) {
          errors.push({
            id,
            code: 'plugin_id_conflict',
            message: `Plugin already registered in-process: ${id}`,
          });
          continue;
        }
        const entry = this.makeEntry(descriptor);
        this.entries.set(id, entry);
        this.registerRpc(entry);
        added.push(id);
        continue;
      }
      if (descriptorFingerprint(existing.descriptor) === descriptorFingerprint(descriptor)) {
        // plugin-embed 契约 §8：descriptor 没变但 bundle 内容可能变了（热更新）。
        // 重算 hash / trust，让 plugins.list 对账拿到新 ui_bundle_hash；
        // 子进程代码未变，不重启。
        const previousHash = existing.embedState?.hash;
        this.refreshEmbedState(existing);
        if (existing.embedState?.hash !== previousHash) changed.push(id);
        continue;
      }
      changed.push(id);
      const wasActive = existing.status === 'active' || existing.starting !== undefined;
      try {
        await this.deactivate(id);
        existing.descriptor = descriptor;
        this.refreshEmbedState(existing);
        existing.enabled = descriptor.enabled ?? true;
        existing.status = existing.enabled ? 'inactive' : 'disabled';
        existing.error = undefined;
        existing.message = undefined;
        this.rpc.unregister(id);
        if (existing.enabled) this.registerRpc(existing);
        if (wasActive && existing.enabled) {
          const settings = this.options.settingsFor?.(id) ?? existing.settings;
          await this.startEntry(existing, settings);
        }
      } catch (error) {
        const code = pluginErrorCodeOf(error) ?? 'plugin_activation_failed';
        existing.status = existing.enabled ? 'unhealthy' : 'disabled';
        existing.error = code;
        existing.message = error instanceof Error ? error.message : String(error);
        errors.push({ id, code, message: existing.message });
        this.publishState(existing);
      }
    }

    // 路由表在每次 reload 后重建；冲突时整体 fail-closed。
    this.rebuildHttpRoutes();

    // active 是「当前活跃插件」单视图：child active + enabled in-process（登记即激活）。
    const activeIds = [
      ...[...this.entries.values()]
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.descriptor.id),
      ...[...this.inProcess.values()]
        .filter((record) => record.enabled)
        .map((record) => record.descriptor.id),
    ];
    const result: PluginReloadResult = {
      added,
      removed,
      changed,
      active: activeIds.sort(),
      errors,
    };
    try {
      this.options.onChanged?.(this.contributionsSnapshot());
    } catch {
      // 广播失败不影响 reload 结果
    }
    return result;
  }

  /** `plugin.changed` 的 `plugins.list` 形状快照（child + 已登记的 in-process）。 */
  contributionsSnapshot(): PluginContributionsSnapshot {
    const plugins: PluginContributionsSnapshot['plugins'] = [...this.entries.values()].map(
      (entry) => {
        const item: PluginContributionsSnapshot['plugins'][number] = {
          name: entry.descriptor.id,
          enabled: entry.enabled,
        };
        if (entry.enabled && entry.status !== 'invalid') {
          const contributions = renderContributions(entry.descriptor);
          if (contributions !== undefined) item.contributions = contributions;
        }
        return item;
      },
    );
    for (const record of this.inProcess.values()) {
      const item: PluginContributionsSnapshot['plugins'][number] = {
        name: record.descriptor.id,
        enabled: record.enabled,
      };
      if (record.enabled) {
        const contributions = renderContributions(record.descriptor);
        if (contributions !== undefined) item.contributions = contributions;
      }
      plugins.push(item);
    }
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    return { plugins };
  }

  /**
   * 停用但保持 enabled；RPC 定义保留，下次访问会再次懒激活。
   * child-only 机制：in-process 与进程同寿命，没有可停的子进程 —— no-op
   * （卸载模块需要重启，装配层以 restart_required 表达）。
   */
  async deactivate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.restartTimer !== undefined) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    entry.status = entry.enabled ? 'inactive' : 'disabled';
    // 0.48 M3：先下线 WS（不再接受新 upgrade），再退订 / terminate（§4.6）。
    this.closeWebSockets(id, 1001, 'plugin_unavailable');
    this.unsubscribeEvents(entry);
    // RPC 定义保留：下次页面 / RPC 访问重新懒激活（disable 才移除）。
    const child = entry.child;
    entry.child = undefined;
    entry.httpEndpoint = undefined;
    if (child !== undefined) await child.terminate();
    this.publishState(entry);
  }

  /**
   * 禁用：停止子进程、取消订阅与 RPC，下次启动不加载。
   * 双轨：in-process 无子进程可停，只翻 enabled + 注销 RPC（静态挂载 /
   * 贡献面 / ensureActive 随 enabled 立即收口）；handler 留存供 enable 恢复。
   */
  async disable(id: string): Promise<void> {
    const inProcessRecord = this.inProcess.get(id);
    if (inProcessRecord !== undefined) {
      inProcessRecord.enabled = false;
      this.rpc.unregister(id);
      this.publishInProcessState(inProcessRecord);
      return;
    }
    const entry = this.requireEntry(id);
    entry.enabled = false;
    await this.deactivate(id);
    this.rpc.unregister(id);
    // 0.48 M4：enable/disable 立即重算 effective HTTP 路由（§6.2）。
    this.rebuildHttpRoutes();
  }

  /**
   * 启用但保持懒激活。双轨：in-process 登记即激活，翻 enabled + 重注册 RPC；
   * child 恢复 inactive 等首次访问 spawn。
   */
  enable(id: string): void {
    const inProcessRecord = this.inProcess.get(id);
    if (inProcessRecord !== undefined) {
      inProcessRecord.enabled = true;
      this.registerInProcessRpc(inProcessRecord);
      this.publishInProcessState(inProcessRecord);
      return;
    }
    const entry = this.requireEntry(id);
    if (entry.status === 'invalid') return;
    entry.enabled = true;
    if (entry.status === 'disabled') entry.status = 'inactive';
    entry.error = undefined;
    entry.message = undefined;
    this.registerRpc(entry);
    this.rebuildHttpRoutes();
    this.publishState(entry);
  }

  /**
   * 注入 / 替换事件源；active plugin 重新订阅。
   * child-only 机制：事件经 `plugin.event` NDJSON 管道发给子进程；
   * in-process 插件的事件面由 core 运行时装配接线，不经这里。
   */
  attachEventSource(source: PluginEventSource): void {
    this.eventSource = source;
    for (const entry of this.entries.values()) {
      if (entry.status !== 'active') continue;
      this.unsubscribeEvents(entry);
      this.subscribeEvents(entry);
    }
  }

  /**
   * model-registry D3：登记 in-process 能力插件（additive；install 之后由装配层调用）。
   *
   * 与 child 共用同一个 PluginRpcRegistry / canonical 名 / DTO 校验；handler 是
   * 插件自己的 `Plugin.rpc`（传输无关），不经子进程 dispatch。声明了
   * contributes.rpc 却没有 handler 时 fail-closed，不产生半注册。
   *
   * 机制边界（S8）：动态 HTTP 面（contributes.http）是 child-only —— 代理目标
   * 是子进程自报的 loopback endpoint，in-process 没有这个机制。声明了 http
   * 的 in-process 插件在这里 fail-closed 拒绝，而不是登记后静默 404。
   * 事件管道（attachEventSource → child.notifyEvent）同为 child-only；
   * in-process 插件的事件面由 core 运行时装配直接接线，不经本 manager。
   */
  registerInProcess(descriptor: PluginDescriptor, handler?: PluginRpcHandler): void {
    const validated = validateDescriptor(
      descriptor,
      this.httpLimits,
      this.options.httpReservedPath ?? isHostReservedPath,
    );
    const id = validated.id;
    if (this.entries.has(id) || this.inProcess.has(id)) {
      throw pluginError('plugin_id_conflict', `Plugin already registered: ${id}`, { id });
    }
    if ((validated.contributes?.http ?? []).length > 0) {
      throw pluginError(
        'plugin_manifest_invalid',
        `In-process plugin "${id}" cannot declare contributes.http: dynamic HTTP requires a child process endpoint.`,
        { id },
      );
    }
    const enabled = validated.enabled ?? true;
    const record: InProcessRecord = {
      descriptor: validated,
      enabled,
      ...(handler !== undefined ? { handler } : {}),
    };
    // plugin-embed 契约 §3：与 child 同一算法计算 trust + hash，
    // plugins.list 元数据（ui_trust / ui_bundle_hash / ui_embed）双轨同口径。
    const embedState = this.embedStateFor(validated);
    if (embedState !== undefined) record.embedState = embedState;
    if (enabled) this.registerInProcessRpc(record);
    this.inProcess.set(id, record);
  }

  /** in-process RPC 注册（enable / 登记共用）；未声明 rpc → no-op，声明了却无 handler → fail-closed。 */
  private registerInProcessRpc(record: InProcessRecord): void {
    const id = record.descriptor.id;
    const methods = record.descriptor.contributes?.rpc ?? [];
    if (methods.length === 0 || this.rpc.hasPlugin(id)) return;
    if (record.handler === undefined) {
      throw pluginError(
        'plugin_manifest_invalid',
        `In-process plugin "${id}" declares contributes.rpc but provides no rpc handler.`,
        { id },
      );
    }
    this.rpc.register(id, methods, record.handler);
  }

  /** id → 渲染字段（单视图）；只含 enabled 的插件（child + 已登记的 in-process）。 */
  contributionsFor(): Record<string, PluginRenderContributions> {
    const output: Record<string, PluginRenderContributions> = {};
    for (const entry of this.entries.values()) {
      if (!entry.enabled || entry.status === 'invalid') continue;
      const contributions = renderContributions(entry.descriptor);
      if (contributions !== undefined) output[entry.descriptor.id] = contributions;
    }
    for (const record of this.inProcess.values()) {
      if (!record.enabled) continue;
      const contributions = renderContributions(record.descriptor);
      if (contributions !== undefined) output[record.descriptor.id] = contributions;
    }
    return output;
  }

  /** S4：写路径用的 settings spec + 运行模式（child = spawn 后不可变）。 */
  settingSpecFor(
    id: string,
  ): { settings: Record<string, unknown>; mode: 'in-process' | 'child' } | undefined {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      return { settings: entry.descriptor.contributes?.settings ?? {}, mode: 'child' };
    }
    const record = this.inProcess.get(id);
    if (record !== undefined) {
      return { settings: record.descriptor.contributes?.settings ?? {}, mode: 'in-process' };
    }
    return undefined;
  }

  /** enabled 且声明 ui.dir 的静态挂载（child + 已登记的 in-process）。 */
  staticMounts(): PluginStaticMount[] {
    const mounts: PluginStaticMount[] = [];
    for (const entry of this.entries.values()) {
      if (!entry.enabled || entry.status === 'invalid') continue;
      const uiDir = entry.descriptor.uiDir;
      if (uiDir === undefined) continue;
      const embed = entry.descriptor.uiEmbed;
      mounts.push({
        id: entry.descriptor.id,
        uiDir,
        // plugin-embed 契约 §5：入口 / CSS 走 no-cache，其余资产保持 immutable。
        ...(embed !== undefined
          ? {
              embedEntry: normalizeEmbedRelPath(embed.entry),
              ...(embed.css !== undefined ? { embedCss: normalizeEmbedRelPath(embed.css) } : {}),
            }
          : {}),
      });
    }
    // in-process 与 child 同口径（镜像 contributionsFor 的双遍历）；
    // descriptor 登记时已 fail-closed 复检，无 status 维度。
    for (const record of this.inProcess.values()) {
      if (!record.enabled) continue;
      const uiDir = record.descriptor.uiDir;
      if (uiDir === undefined) continue;
      const embed = record.descriptor.uiEmbed;
      mounts.push({
        id: record.descriptor.id,
        uiDir,
        ...(embed !== undefined
          ? {
              embedEntry: normalizeEmbedRelPath(embed.entry),
              ...(embed.css !== undefined ? { embedCss: normalizeEmbedRelPath(embed.css) } : {}),
            }
          : {}),
      });
    }
    return mounts;
  }

  /**
   * 状态列表（`vessel plugin list` / plugins.list E10 元数据）。
   * 双轨：child entries + 已登记的 in-process（mode: 'in-process'，
   * 登记即激活 → enabled ? 'active' : 'disabled'）。漏掉 in-process 会让
   * plugins.list 缺 version/mode/status/ui_*，web embed 档直接回落 iframe。
   */
  statuses(): PluginStatusEntry[] {
    return [
      ...[...this.entries.values()].map((entry) => this.statusOf(entry)),
      ...[...this.inProcess.values()].map((record) => this.inProcessStatusOf(record)),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** 单插件状态；双轨（child + in-process），未知 id → undefined。 */
  status(id: string): PluginStatusEntry | undefined {
    const entry = this.entries.get(id);
    if (entry !== undefined) return this.statusOf(entry);
    const record = this.inProcess.get(id);
    return record !== undefined ? this.inProcessStatusOf(record) : undefined;
  }

  /** 0.48 M1：插件 HTTP 路由匹配；冲突 / 无路由 → `none`。 */
  match(method: string, pathname: string): PluginHttpMatch {
    return matchPluginHttpRoute(this.httpRoutes, method, pathname);
  }

  /** 0.48 M1/M4：全部冲突（plugin 级只影响该插件；surface 级整体 fail-closed）。 */
  conflicts(): readonly PluginHttpRouteConflict[] {
    return this.httpConflicts;
  }

  /** 0.48 M4：effective 跨插件冲突导致整个 HTTP 面 fail-closed。 */
  httpSurfaceDisabled(): boolean {
    return this.httpConflicts.some((conflict) => conflict.scope === 'surface');
  }

  /**
   * 本次 spawn 的 endpoint + token；仅 active 时可用。
   * child-only 机制：动态 HTTP 代理目标是子进程 loopback endpoint；
   * in-process 无此面（registerInProcess 拒绝 contributes.http）。
   */
  httpEndpointFor(id: string): PluginHttpTarget | undefined {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.status !== 'active') return undefined;
    return entry.httpEndpoint;
  }

  /**
   * 0.48 M1：解析插件 HTTP 目标。首次访问按需激活（与页面 / RPC 一致）。
   * disabled → 404；invalid / unhealthy / 无 endpoint → 503；只有 active → ready。
   * child-only 机制（S8 边界）：只查 child entries —— 动态 HTTP 需要子进程
   * endpoint；in-process 的 UI 走 staticMounts 静态面，不进这里。
   */
  async resolve(pluginId: string): Promise<PluginHttpResolution> {
    const entry = this.entries.get(pluginId);
    if (entry === undefined) return { kind: 'disabled' };
    if (!entry.enabled || entry.status === 'disabled') return { kind: 'disabled' };
    if (entry.status === 'invalid') return { kind: 'unavailable' };
    try {
      await this.ensureActive(pluginId);
    } catch {
      // 激活失败已写入 entry.status；disabled / invalid 走不同 HTTP 语义。
      // 读 helper 防止 TS 把前面的收窄当成不变。
      if (!entry.enabled || this.statusNow(entry) === 'disabled') return { kind: 'disabled' };
      return { kind: 'unavailable' };
    }
    const target = entry.httpEndpoint;
    if (entry.status !== 'active' || target === undefined) return { kind: 'unavailable' };
    return { kind: 'ready', target };
  }

  /** 被 deny 的宿主 API 次数（探针 / 诊断）。child-only：deny 发生在子进程 RPC 面。 */
  denialsFor(id: string): number {
    return this.entries.get(id)?.denials ?? 0;
  }

  /** 0.48 M3：WS 计数快照（只供日志 / 诊断，不暴露 RPC）。 */
  webSocketStats(pluginId: string): PluginWebSocketStats | undefined {
    const stats = this.wsStats.get(pluginId);
    return stats !== undefined ? { ...stats } : undefined;
  }

  /**
   * 幂等关闭全部子进程与订阅。
   * in-process 无子进程 / 订阅可关：其 RPC 由末尾 rpc.clear() 统一注销；
   * 登记记录保留（本方法是终态关闭，之后不应再服务请求）。
   */
  async stopAll(): Promise<void> {
    const tasks: Array<Promise<void>> = [];
    for (const entry of this.entries.values()) {
      // 0.48 M3：先关 WS 再 terminate（§4.6）。
      this.closeWebSockets(entry.descriptor.id, 1001, 'plugin_unavailable');
      if (entry.restartTimer !== undefined) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = undefined;
      }
      this.unsubscribeEvents(entry);
      this.rpc.unregister(entry.descriptor.id);
      const child = entry.child;
      entry.child = undefined;
      entry.httpEndpoint = undefined;
      if (child !== undefined) tasks.push(child.terminate());
      entry.status = entry.enabled ? 'inactive' : 'disabled';
    }
    await Promise.all(tasks);
    this.rpc.clear();
  }

  /** 0.48 M3：关闭某插件的全部客户端 WS（幂等；句柄自行保证只关一次）。 */
  private closeWebSockets(pluginId: string, code: number, reason: string): void {
    const connections = this.wsConnections.get(pluginId);
    if (connections === undefined) return;
    for (const handle of [...connections]) {
      try {
        handle.close(code, reason);
      } catch {
        // 连接已结束
      }
    }
  }

  private statsFor(pluginId: string): PluginWebSocketStats {
    let stats = this.wsStats.get(pluginId);
    if (stats === undefined) {
      stats = emptyWebSocketStats();
      this.wsStats.set(pluginId, stats);
    }
    return stats;
  }

  /**
   * 0.48 M1/M4：按当前 descriptor + `expose` 重建 effective HTTP 路由表。
   * - invalid / disabled 插件不进入；
   * - plugin 级冲突只排除该插件，surface 级冲突整体 fail-closed。
   * child-only 机制（S8 边界）：路由代理到子进程 endpoint；in-process 声明
   * contributes.http 已在 registerInProcess fail-closed，不会出现在这里。
   */
  private rebuildHttpRoutes(): void {
    // invalid 条目的 descriptor 可能是校验失败后的兜底值（保留原始 http 声明），
    // 不能进入路由表，否则一个坏插件会把整个 HTTP 面拖成冲突态。
    const inputs = [...this.entries.values()]
      .filter((entry) => entry.enabled && entry.status !== 'invalid')
      .map((entry) => {
        const expose = this.options.exposeFor?.(entry.descriptor.id);
        // builtin 忽略 expose（CONTRACT-0.48 §5.2），只提示一次。
        if (
          expose !== undefined &&
          entry.descriptor.builtin === true &&
          !this.warnedBuiltinExpose.has(entry.descriptor.id)
        ) {
          this.warnedBuiltinExpose.add(entry.descriptor.id);
          this.logger('warn', 'plugin.expose.ignored', {
            plugin: entry.descriptor.id,
            reason: 'builtin',
          });
        }
        // 未知 expose id → warning + 忽略（CONTRACT-0.48 §5.1 / §5.3），不拒绝插件。
        if (expose !== undefined && entry.descriptor.builtin !== true) {
          const declared = new Set(
            (entry.descriptor.contributes?.http ?? []).map((route) => route.id),
          );
          for (const id of expose.http ?? []) {
            if (!declared.has(id)) {
              this.logger('warn', 'plugin.expose.unknown_id', {
                plugin: entry.descriptor.id,
                surface: 'http',
                id,
              });
            }
          }
        }
        return {
          pluginId: entry.descriptor.id,
          builtin: entry.descriptor.builtin === true,
          declarations: entry.descriptor.contributes?.http,
          ...(expose !== undefined ? { expose } : {}),
        };
      })
      .filter((input) => input.declarations !== undefined);
    const table = buildPluginHttpRouteTable(
      inputs,
      this.httpLimits,
      this.options.httpReservedPath ?? isHostReservedPath,
    );
    this.httpRoutes = table.routes;
    this.httpConflicts = table.conflicts;
    if (table.conflicts.length > 0) {
      const fields = {
        conflicts: table.conflicts.map(
          (conflict) =>
            `${conflict.scope}:${conflict.pluginId}:${conflict.routeId ?? '?'}:${conflict.reason}:${conflict.path ?? ''}`,
        ),
      };
      if (table.conflicts.some((conflict) => conflict.scope === 'surface')) {
        this.logger('error', 'plugin http surface disabled: effective route conflicts', fields);
      } else {
        this.logger('warn', 'plugin http declarations rejected', fields);
      }
    }
  }

  private makeEntry(descriptor: PluginDescriptor): Entry {
    const enabled = descriptor.enabled ?? true;
    const entry: Entry = {
      descriptor,
      enabled,
      status: enabled ? 'inactive' : 'disabled',
      limiter: new EventRateLimiter(this.eventsPerSecond, this.now),
      dropped: 0,
      denials: 0,
      restarts: [],
      settings: {},
    };
    this.refreshEmbedState(entry);
    return entry;
  }

  /**
   * plugin-embed 契约 §3：descriptor 加载 / reload 时计算 trust + hash。
   * 无 ui.embed / embedRoot 不可读 → 字段缺省（视同无 embed，fail-closed）。
   */
  private refreshEmbedState(entry: Entry): void {
    entry.embedState = this.embedStateFor(entry.descriptor);
  }

  /** embed trust + hash 单实现（child 与 in-process 共用同一算法 / TOFU 锁）。 */
  private embedStateFor(
    descriptor: PluginDescriptor,
  ): { trust: PluginUiTrust; hash: string } | undefined {
    const embed = descriptor.uiEmbed;
    if (embed === undefined || descriptor.uiDir === undefined) return undefined;
    const embedRoot = resolve(descriptor.uiDir, dirname(embed.entry));
    const hash = computeEmbedHash(embedRoot);
    if (hash === null) return undefined;
    return {
      trust: resolveUiTrust(descriptor, hash, this.dataDir, this.logger),
      hash,
    };
  }

  /** 懒激活：RPC 定义在 enable 时即可被 dispatcher 解析，首次调用再 spawn。 */
  private registerRpc(entry: Entry): void {
    if (!entry.enabled || entry.status === 'invalid') return;
    if (this.rpc.hasPlugin(entry.descriptor.id)) return;
    const methods = entry.descriptor.contributes?.rpc ?? [];
    if (methods.length === 0) return;
    this.rpc.register(entry.descriptor.id, methods, (name, params) =>
      this.callRpc(entry, name, params),
    );
  }

  private async startEntry(entry: Entry, settingsInput: Record<string, unknown>): Promise<void> {
    if (entry.status === 'active') return;
    if (entry.starting !== undefined) return entry.starting;
    const task = this.doStart(entry, settingsInput);
    entry.starting = task;
    try {
      await task;
    } finally {
      entry.starting = undefined;
    }
  }

  private async doStart(entry: Entry, settingsInput: Record<string, unknown>): Promise<void> {
    const descriptor = entry.descriptor;
    const settings = filterSettings(descriptor, settingsInput, (message, meta) => {
      this.logger('warn', message, meta);
    });
    entry.status = 'starting';
    entry.error = undefined;
    entry.message = undefined;
    this.publishState(entry);

    const dataDir = join(this.dataDir, 'plugins', descriptor.id);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // 每次 spawn 轮换内部 HTTP token；只经 activate 参数下发。
    const httpToken =
      (descriptor.contributes?.http ?? []).length > 0
        ? randomBytes(32).toString('base64url')
        : undefined;
    const child = new ChildPluginProcess({
      descriptor,
      settings,
      dataDir,
      // §3.2.1：全局 data dir 只读；是否下发给 activate 由 child 按权限判断。
      globalDataDir: this.dataDir,
      ...(this.options.execPath !== undefined ? { execPath: this.options.execPath } : {}),
      ...(this.options.timeouts !== undefined ? { timeouts: this.options.timeouts } : {}),
      ...(httpToken !== undefined ? { httpToken } : {}),
      hooks: {
        onExit: (info) => this.handleExit(entry, child, info),
        onLog: () => {},
        onReady: () => this.options.onReady?.(descriptor.id),
        onPermissionDenied: (api) => {
          entry.denials += 1;
          this.logger('warn', 'plugin permission denied', { plugin: descriptor.id, api });
          this.options.onPermissionDenied?.(descriptor.id, api);
        },
      },
    });
    entry.child = child;
    entry.settings = settings;

    try {
      await child.start();
      entry.status = 'active';
      entry.error = undefined;
      entry.message = undefined;
      entry.httpEndpoint =
        child.httpEndpoint !== undefined && httpToken !== undefined
          ? { url: child.httpEndpoint, token: httpToken }
          : undefined;
      this.subscribeEvents(entry);
      this.publishState(entry);
    } catch (error) {
      entry.child = undefined;
      entry.httpEndpoint = undefined;
      entry.error = pluginErrorCodeOf(error) ?? 'plugin_activation_failed';
      entry.message = error instanceof Error ? error.message : String(error);
      entry.status =
        entry.error === 'plugin_manifest_invalid' || entry.error === 'plugin_config_invalid'
          ? 'invalid'
          : 'unhealthy';
      // invalid 不再对外暴露 RPC；unhealthy 保留定义，下次访问可重试懒激活。
      if (entry.status === 'invalid') this.rpc.unregister(descriptor.id);
      this.publishState(entry);
      throw error;
    }
  }

  private async callRpc(
    entry: Entry,
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // 动态 RPC 分发：首次调用 plugin.<id>.<name> 在转发前懒激活。
    await this.ensureActive(entry.descriptor.id);
    const child = entry.child;
    if (child === undefined || entry.status !== 'active') {
      throw pluginError('plugin_activation_failed', 'Plugin is not active.', {
        plugin: entry.descriptor.id,
      });
    }
    try {
      return await child.callRpc(name, params);
    } catch (error) {
      const code = pluginErrorCodeOf(error);
      // 重启上限已把 plugin 禁用时，迟到的 RPC 拒绝不得把状态改回 unhealthy。
      // 读 helper 而不是直接比较 `entry.status`：TS 在前面已把它收窄成 'active'。
      if (
        (code === 'plugin_timeout' || code === 'plugin_crashed') &&
        entry.enabled &&
        this.statusNow(entry) !== 'disabled'
      ) {
        entry.status = 'unhealthy';
        entry.error = code;
        entry.message = error instanceof Error ? error.message : String(error);
        this.publishState(entry);
      }
      throw error;
    }
  }

  /** 读取运行期状态（防止 TS 把已收窄的字段当成不变）。 */
  private statusNow(entry: Entry): PluginRuntimeStatus {
    return entry.status;
  }

  private handleExit(entry: Entry, child: ChildPluginProcess, info: ChildExitInfo): void {
    // 旧进程的退出可能晚于一次重新激活：只处理当前 child 的事件，
    // 否则会把新子进程引用 / 新订阅清掉（超时 + 立即懒激活的竞态）。
    if (entry.child !== child) return;
    entry.child = undefined;
    entry.httpEndpoint = undefined;
    // 0.48 M3：插件退出 / 崩溃 → 关闭该插件全部客户端 WS（不自动重连）。
    this.closeWebSockets(
      entry.descriptor.id,
      info.expected ? 1001 : 1011,
      info.expected ? 'plugin_unavailable' : 'plugin_crashed',
    );
    this.unsubscribeEvents(entry);
    // RPC 定义保留：崩溃 / 超时后下一次访问仍可懒激活（禁用时才移除）。

    // 宿主主动触发（deactivate / disable / 超时）：不再自动重启。
    if (info.expected) {
      if (info.errorCode === 'plugin_timeout' || info.errorCode === 'plugin_payload_too_large') {
        entry.status = 'unhealthy';
        entry.error = info.errorCode;
        entry.message = info.message;
      }
      this.publishState(entry);
      return;
    }

    entry.status = 'unhealthy';
    entry.error = info.errorCode ?? 'plugin_crashed';
    entry.message = info.message ?? 'Plugin process exited unexpectedly.';
    this.publishState(entry);
    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: Entry): void {
    const now = this.now();
    entry.restarts = entry.restarts.filter((timestamp) => now - timestamp < this.restartWindowMs);
    if (entry.restarts.length >= this.maxRestarts) {
      entry.enabled = false;
      entry.status = 'disabled';
      this.rpc.unregister(entry.descriptor.id);
      entry.message = `Exceeded ${this.maxRestarts} restarts within ${Math.round(
        this.restartWindowMs / 60000,
      )} minutes.`;
      this.logger('error', 'plugin disabled after repeated crashes', {
        plugin: entry.descriptor.id,
        restarts: entry.restarts.length,
      });
      this.publishState(entry);
      return;
    }
    entry.restarts.push(now);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = undefined;
      void this.startEntry(entry, entry.settings).catch(() => {
        // 启动失败已写入状态；不再无限重试
      });
    }, this.restartDelayMs);
  }

  private subscribeEvents(entry: Entry): void {
    const source = this.eventSource;
    if (source === undefined || entry.unsubscribe !== undefined) return;
    const patterns = entry.descriptor.contributes?.events ?? [];
    if (patterns.length === 0) return;
    entry.unsubscribe = source.subscribe((event) => {
      const transformed = this.options.redact !== undefined ? this.options.redact(event) : event;
      if (!matchesEventFilter(transformed.type, patterns)) return;
      const dtoViolation = jsonDtoViolation(transformed, 'event');
      if (dtoViolation !== null) {
        this.recordDrop(entry);
        return;
      }
      if (!entry.limiter.allow()) {
        this.recordDrop(entry);
        return;
      }
      entry.child?.notifyEvent(transformed);
    });
  }

  private unsubscribeEvents(entry: Entry): void {
    if (entry.unsubscribe === undefined) return;
    try {
      entry.unsubscribe();
    } catch {
      // 幂等退订
    }
    entry.unsubscribe = undefined;
  }

  private recordDrop(entry: Entry): void {
    entry.dropped += 1;
    this.options.onEventDropped?.(entry.descriptor.id, entry.dropped);
  }

  /** child 条目状态（child-only：restart / dropped / error 都是子进程语义）。 */
  private statusOf(entry: Entry): PluginStatusEntry {
    const now = this.now();
    const restarts = entry.restarts.filter((timestamp) => now - timestamp < this.restartWindowMs);
    // TI5-6：持久化 config 快照进元数据（web 设置回显 / 写确认消费）。
    const config = this.persistedConfigOf(entry.descriptor);
    return {
      id: entry.descriptor.id,
      status: entry.status,
      enabled: entry.enabled,
      ...(entry.descriptor.version.length > 0 ? { version: entry.descriptor.version } : {}),
      mode: 'child',
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.message !== undefined ? { message: entry.message } : {}),
      events_dropped: entry.dropped,
      restarts: restarts.length,
      ...(config !== undefined ? { config } : {}),
      ...(entry.embedState !== undefined && entry.descriptor.uiEmbed !== undefined
        ? {
            ui_trust: entry.embedState.trust,
            ui_bundle_hash: entry.embedState.hash,
            ui_embed: entry.descriptor.uiEmbed,
          }
        : {}),
    };
  }

  /** in-process 状态（双轨另一轨）：登记即激活，无 restart / dropped 维度。 */
  private inProcessStatusOf(record: InProcessRecord): PluginStatusEntry {
    // TI5-6：in-process 登记是一次性的（descriptor.settings 是启动快照），
    // settingsFor 活配置读端口保证 plugins.config.set 写后回显新鲜。
    const config = this.persistedConfigOf(record.descriptor);
    return {
      id: record.descriptor.id,
      status: record.enabled ? 'active' : 'disabled',
      enabled: record.enabled,
      ...(record.descriptor.version.length > 0 ? { version: record.descriptor.version } : {}),
      mode: 'in-process',
      events_dropped: 0,
      restarts: 0,
      ...(config !== undefined ? { config } : {}),
      ...(record.embedState !== undefined && record.descriptor.uiEmbed !== undefined
        ? {
            ui_trust: record.embedState.trust,
            ui_bundle_hash: record.embedState.hash,
            ui_embed: record.descriptor.uiEmbed,
          }
        : {}),
    };
  }

  /**
   * TI5-6：插件持久化 config（config `plugins[].config` 原值，不含 default）。
   * settingsFor 优先（装配注入的活配置读端口，gateway 读 liveConfig）；
   * 无端口回退 descriptor.settings（本地模式启动快照，语义不变）。
   * 空对象 → undefined（wire 整字段缺省 = 无持久化值，不发射空壳）。
   */
  private persistedConfigOf(descriptor: PluginDescriptor): Record<string, unknown> | undefined {
    const config = this.options.settingsFor?.(descriptor.id) ?? descriptor.settings ?? {};
    return Object.keys(config).length > 0 ? config : undefined;
  }

  private publishState(entry: Entry): void {
    this.options.onStateChange?.(this.statusOf(entry));
  }

  private publishInProcessState(record: InProcessRecord): void {
    this.options.onStateChange?.(this.inProcessStatusOf(record));
  }

  /** child-only 查找（S8 边界）：in-process 走 this.inProcess，不经过这里。 */
  private requireEntry(id: string): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw pluginError('plugin_manifest_invalid', `Unknown plugin: ${id}`, { id });
    }
    return entry;
  }
}

/** 运行期状态 → `plugins.list[].status`（瞬态 starting/stopped 归一为 inactive）。 */
export function toPluginListStatus(status: PluginRuntimeStatus): PluginListStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'unhealthy':
      return 'unhealthy';
    case 'disabled':
      return 'disabled';
    case 'invalid':
      return 'invalid';
    default:
      return 'inactive';
  }
}

/** `plugins.list` / `plugin.changed` 共用元数据映射。 */
export function pluginListMetadata(
  statuses: readonly PluginStatusEntry[],
): Record<string, PluginListMetadata> {
  const output: Record<string, PluginListMetadata> = {};
  for (const status of statuses) {
    output[status.id] = {
      ...(status.version !== undefined ? { version: status.version } : {}),
      ...(status.mode !== undefined ? { mode: status.mode } : {}),
      status: toPluginListStatus(status.status),
      // TI5-6 additive：持久化 config 快照（web 设置回显 / 写确认消费）。
      ...(status.config !== undefined ? { config: status.config } : {}),
      // plugin-embed 契约 §3：embed 信任态（无 ui.embed 的插件缺省）。
      ...(status.ui_trust !== undefined ? { ui_trust: status.ui_trust } : {}),
      ...(status.ui_bundle_hash !== undefined ? { ui_bundle_hash: status.ui_bundle_hash } : {}),
      ...(status.ui_embed !== undefined ? { ui_embed: status.ui_embed } : {}),
    };
  }
  return output;
}

/** 只返回可渲染字段（contract §2.7）；能力插件 / 无 UI 贡献 → undefined。 */
export function renderContributions(
  descriptor: PluginDescriptor,
): PluginRenderContributions | undefined {
  const contributes = descriptor.contributes;
  if (contributes === undefined) return undefined;
  const navGroups = (contributes.navGroups ?? [])
    .map((group) => ({
      id: group.id,
      title: group.title,
      ...(group.titleKey !== undefined ? { titleKey: group.titleKey } : {}),
      ...(group.icon !== undefined ? { icon: group.icon } : {}),
      order: group.order ?? 100,
    }))
    .sort((a, b) => a.order - b.order);
  const pages = (contributes.pages ?? [])
    .map((page) => ({
      id: page.id,
      title: page.title,
      ...(page.titleKey !== undefined ? { titleKey: page.titleKey } : {}),
      nav: page.nav ?? 'observe',
      ...(page.icon !== undefined ? { icon: page.icon } : {}),
      order: page.order ?? 100,
      entry: safeEntry(page.entry),
      route: routeFor(descriptor.id, page.entry),
      ...(page.component !== undefined ? { component: page.component } : {}),
    }))
    // E5：分组内页面按 order 升序；同 order 保持 manifest 顺序。
    .sort((a, b) => a.order - b.order);
  const panels = (contributes.panels ?? []).map((panel) => ({
    slot: panel.slot,
    id: panel.id,
    ...(panel.title !== undefined ? { title: panel.title } : {}),
    order: panel.order ?? 100,
    entry: safeEntry(panel.entry),
    route: routeFor(descriptor.id, panel.entry),
  }));
  const commands = (contributes.commands ?? []).map((command) => ({
    name: command.name,
    title: command.title,
  }));
  // 0.51 additive：输入框工具栏声明；没有 entry，按 order 升序。
  const toolbar = (contributes.toolbar ?? [])
    .map((item) => ({
      slot: item.slot,
      id: item.id,
      label: item.label,
      ...(item.titleKey !== undefined ? { titleKey: item.titleKey } : {}),
      ...(item.icon !== undefined ? { icon: item.icon } : {}),
      order: item.order ?? 100,
      // P3 additive：通用 RPC 绑定菜单原样透传（loader readToolbarMenu 已校验形状）。
      ...(item.menu !== undefined ? { menu: item.menu } : {}),
      // file-ref P3 additive：插件自持点击动作（loader 已校验形状/互斥/ui.embed）。
      ...(item.action !== undefined ? { action: item.action } : {}),
    }))
    .sort((a, b) => a.order - b.order);
  // E1 amendment：bare 方法名；web iframe bridge 用它做 RPC 白名单。
  // TI5-5 additive：write 方法发 {name, permission} 对象携带权限真相（web
  // toolbarMenuOf 校验 menu.write 需要）；read / 缺省保持 bare string（E1
  // canonical 逐字节不变，旧 string-only 消费方零破坏）。
  const rpc = (contributes.rpc ?? []).map((method) =>
    method.permission === 'write'
      ? { name: method.name, permission: 'write' as const }
      : method.name,
  );
  // S3 additive：settings spec 原样透传（loader readSettings 已校验形状）。
  const settings = contributes.settings;
  const hasSettings = settings !== undefined && Object.keys(settings).length > 0;
  // file-ref-ux additive：composer 内嵌贡献原样透传（loader readComposer 已校验形状）。
  const composer = (contributes.composer ?? [])
    .map((item) => ({
      slot: item.slot,
      ...(item.scheme !== undefined ? { scheme: item.scheme } : {}),
      ...(item.component !== undefined ? { component: item.component } : {}),
      ...(item.handler !== undefined ? { handler: item.handler } : {}),
      order: item.order ?? 100,
    }))
    .sort((a, b) => a.order - b.order);
  if (
    pages.length === 0 &&
    panels.length === 0 &&
    toolbar.length === 0 &&
    commands.length === 0 &&
    rpc.length === 0 &&
    composer.length === 0 &&
    !hasSettings
  ) {
    return undefined;
  }
  return {
    navGroups,
    pages,
    panels,
    toolbar,
    commands,
    rpc,
    ...(composer.length > 0 ? { composer } : {}),
    ...(contributes.i18n !== undefined ? { i18n: contributes.i18n } : {}),
    ...(hasSettings ? { settings: settings as Record<string, PluginSettingSpec> } : {}),
  };
}

export { PluginHostError };
